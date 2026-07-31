import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type {
  CreateStorySettingResponse,
  GenerateLlmTextStreamEvent,
  GetStorySettingResponse,
  ListStorySettingsResponse,
} from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { LlmService } from "../llm/llm.service";
import { StorySettingNotFoundError } from "./story-setting.errors";
import { StorySettingService } from "./story-setting.service";

const ndjsonContentType = "application/x-ndjson; charset=utf-8";
const defaultSettingCompletionErrorMessage = "补全设定失败，请稍后重试";

interface StreamRequest {
  on(event: "close", listener: () => void): this;
}

interface StreamResponse {
  setHeader(name: string, value: string): this;
  flushHeaders?: () => void;
  write(chunk: string): boolean;
  end(chunk?: string): this;
}

@Controller("story-settings")
export class StorySettingController {
  constructor(
    private readonly llmService: LlmService,
    private readonly storySettingService: StorySettingService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ListStorySettingsResponse> {
    return this.storySettingService.listSettings(user.userId);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<CreateStorySettingResponse> {
    return this.storySettingService.createSetting({
      body,
      userId: user.userId,
    });
  }

  @Post("complete/stream")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async completeStream(
    @Body() body: unknown,
    @Req() request: StreamRequest,
    @Res() response: StreamResponse,
  ): Promise<void> {
    const llmRequest = this.storySettingService.buildCompletionLlmRequest(body);
    const abortController = new AbortController();
    const startedAt = Date.now();
    let sequence = 0;
    request.on("close", () => {
      abortController.abort();
    });

    configureStreamResponse(response);
    writeStreamEvent(response, {
      type: "started",
    });

    try {
      for await (const event of this.llmService.streamTextFromParsedRequest(
        llmRequest,
        { signal: abortController.signal },
      )) {
        if (abortController.signal.aborted) {
          response.end();
          return;
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

  @Get(":settingId")
  @UseGuards(JwtAuthGuard)
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param("settingId") settingId: string,
  ): Promise<GetStorySettingResponse> {
    const setting = await this.storySettingService.getSettingForUser({
      userId: user.userId,
      settingId,
    });

    if (setting === null) {
      throw new NotFoundException("Story setting not found");
    }

    return { setting };
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
  if (error instanceof StorySettingNotFoundError) {
    return "设定不存在";
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return defaultSettingCompletionErrorMessage;
}
