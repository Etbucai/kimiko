import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type {
  GenerateLlmTextResponse,
  GenerateLlmTextStreamEvent,
} from "@kimiko/schema";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { LlmService } from "./llm.service";

const ndjsonContentType = "application/x-ndjson; charset=utf-8";
const defaultStreamErrorMessage = "生成失败，请稍后重试";

interface StreamRequest {
  on(event: "close", listener: () => void): this;
}

interface StreamResponse {
  setHeader(name: string, value: string): this;
  flushHeaders?: () => void;
  write(chunk: string): boolean;
  end(chunk?: string): this;
}

@Controller("llm")
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post("generate")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  generate(@Body() body: unknown): Promise<GenerateLlmTextResponse> {
    return this.llmService.generateText(body);
  }

  @Post("generate/stream")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async generateStream(
    @Body() body: unknown,
    @Req() request: StreamRequest,
    @Res() response: StreamResponse,
  ): Promise<void> {
    const abortController = new AbortController();
    const startedAt = Date.now();
    let sequence = 0;
    request.on("close", () => {
      abortController.abort();
    });

    const stream = this.llmService.streamText(body, {
      signal: abortController.signal,
    });

    configureStreamResponse(response);
    writeStreamEvent(response, {
      type: "started",
    });

    try {
      for await (const event of stream) {
        if (abortController.signal.aborted) {
          response.end();
          return;
        }

        if (event.type === "reasoning") {
          continue;
        }

        if (event.type === "chunk") {
          sequence += 1;
          writeStreamEvent(response, {
            type: "chunk",
            sequence,
            delta: event.delta,
          });
          continue;
        }

        writeStreamEvent(response, {
          type: "completed",
          model: event.model,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          usage: event.usage,
          ...(event.finishReason !== undefined
            ? { finishReason: event.finishReason }
            : {}),
        });
      }
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        writeStreamEvent(response, {
          type: "error",
          message: getStreamErrorMessage(error),
        });
      }
    }

    response.end();
  }
}

function configureStreamResponse(response: StreamResponse): void {
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Content-Type", ndjsonContentType);
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
}

function writeStreamEvent(
  response: StreamResponse,
  event: GenerateLlmTextStreamEvent,
): void {
  response.write(`${JSON.stringify(event)}\n`);
}

function getStreamErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return defaultStreamErrorMessage;
}
