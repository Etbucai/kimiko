import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Res,
  UseGuards,
  Body,
} from "@nestjs/common";
import type { StoryChapterChatStreamEvent } from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  StoryChapterNotFoundError,
  StoryChatContextTooLargeError,
  StoryChatEmptyResponseError,
  StorylineBusyError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineChatService } from "./storyline-chat.service";
import type { PreparedStoryChatSession } from "./storyline-chat.types";

const ndjsonContentType = "application/x-ndjson; charset=utf-8";

interface StreamResponse {
  readonly writableEnded: boolean;
  end(chunk?: string): this;
  flushHeaders?: () => void;
  on(event: "close", listener: () => void): this;
  setHeader(name: string, value: string): this;
  write(chunk: string): boolean;
}

@Controller("storylines")
export class StorylineChatController {
  constructor(private readonly storylineChatService: StorylineChatService) {}

  @Post(":storylineId/chat/stream")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async streamChapterChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
    @Body() body: unknown,
    @Res() response: StreamResponse,
  ): Promise<void> {
    const abortController = new AbortController();
    let responseEnded = false;
    response.on("close", () => {
      if (!responseEnded) {
        abortController.abort();
      }
    });

    let session: PreparedStoryChatSession;
    try {
      session = await this.storylineChatService.prepare({
        body,
        storylineId,
        userId: user.userId,
      });
    } catch (error: unknown) {
      throw mapStoryChatPreparationHttpError(error);
    }

    try {
      if (abortController.signal.aborted) {
        return;
      }

      configureStreamResponse(response);
      writeStreamEvent(response, { type: "started" });

      for await (const event of session.stream({
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted) {
          return;
        }

        writeStreamEvent(response, event);
      }
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        writeStreamEvent(response, mapStoryChatStreamError(error));
      }
    } finally {
      session.release();
      responseEnded = true;
      if (!response.writableEnded) {
        response.end();
      }
    }
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
  event: StoryChapterChatStreamEvent,
): void {
  response.write(`${JSON.stringify(event)}\n`);
}

function mapStoryChatPreparationHttpError(error: unknown): Error {
  if (error instanceof BadRequestException) {
    return error;
  }

  if (error instanceof StorylineBusyError) {
    return new ConflictException("Storyline is busy");
  }

  if (
    error instanceof StorylineNotFoundError ||
    error instanceof StoryChapterNotFoundError
  ) {
    return new NotFoundException("Storyline or chapter not found");
  }

  if (error instanceof StoryChatContextTooLargeError) {
    return new PayloadTooLargeException("Story chat context is too large");
  }

  return new InternalServerErrorException("Failed to prepare story chat");
}

function mapStoryChatStreamError(error: unknown): StoryChapterChatStreamEvent {
  if (error instanceof StoryChatEmptyResponseError) {
    return {
      type: "error",
      code: "LLM_EMPTY_RESPONSE",
      message: "AI 没有返回回答，请重新提问",
    };
  }

  return {
    type: "error",
    code: "CHAT_FAILED",
    message: "AI 回答失败，请稍后重试",
  };
}
