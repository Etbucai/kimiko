import { BadGatewayException, Injectable } from "@nestjs/common";
import { WebSocketGateway } from "@nestjs/websockets";
import type {
  OnGatewayDisconnect,
  OnGatewayInit,
} from "@nestjs/websockets";
import type {
  StoryCancelClientMessage,
  StoryContinueClientMessage,
  StoryRealtimeClientMessage,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import { StoryRealtimeClientMessageSchema } from "@kimiko/schema";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { verifyAccessToken } from "../auth/jwt-auth.utils";
import {
  StorySegmentNotRewritableError,
  StorylineBusyError,
  StorylineNotFoundError,
  StorylineSaveFailedError,
  StorySummaryFailedError,
} from "../storyline/storyline.errors";
import { StorylineGenerationService } from "../storyline/storyline-generation.service";
import type { StorylineStreamEvent } from "../storyline/storyline.types";
import type {
  ActiveRealtimeTask,
  RealtimeClientState,
  RealtimeErrorCode,
} from "./realtime.types";

const unauthorizedCloseCode = 1008;
const unauthorizedCloseReason = "Unauthorized";

const errorMessages: Record<RealtimeErrorCode, string> = {
  INVALID_MESSAGE: "消息格式不正确",
  INVALID_PAYLOAD: "请求参数不正确",
  BUSY: "当前连接已有生成任务",
  NO_ACTIVE_TASK: "当前没有可取消的生成任务",
  GENERATION_FAILED: "生成失败，请稍后重试",
  LLM_EMPTY_RESPONSE: "生成结果为空，请稍后重试",
  LLM_USAGE_MISSING: "生成元数据缺失，请稍后重试",
  STORYLINE_NOT_FOUND: "故事线不存在",
  STORYLINE_BUSY: "当前故事线正在生成，请稍后重试",
  STORYLINE_SAVE_FAILED: "保存失败，请稍后重试",
  STORY_SUMMARY_FAILED: "生成失败，请稍后重试",
  STORY_SEGMENT_NOT_REWRITABLE: "当前段落不可重写",
};

@Injectable()
@WebSocketGateway({ path: "/realtime" })
export class RealtimeGateway
  implements OnGatewayInit<WebSocketServer>, OnGatewayDisconnect<WebSocket>
{
  private readonly clientStates = new WeakMap<WebSocket, RealtimeClientState>();

  constructor(
    private readonly storylineGenerationService: StorylineGenerationService,
  ) {}

  afterInit(server: WebSocketServer): void {
    server.on("connection", (client, request) => {
      this.bindConnection(client, request);
    });
  }

  private bindConnection(client: WebSocket, request: IncomingMessage): void {
    const accessToken = getAccessTokenFromRequest(request);
    if (accessToken === null) {
      client.close(unauthorizedCloseCode, unauthorizedCloseReason);
      return;
    }

    try {
      const payload = verifyAccessToken(accessToken);
      this.clientStates.set(client, {
        activeTask: null,
        user: {
          sub: payload.sub,
          uniqueName: payload.uniqueName,
        },
      });
      bindClientMessageHandler(client, (rawMessage) => {
        void this.handleRawMessage(client, rawMessage);
      });
    } catch {
      client.close(unauthorizedCloseCode, unauthorizedCloseReason);
    }
  }

  handleDisconnect(client: WebSocket): void {
    const clientState = this.clientStates.get(client);
    clientState?.activeTask?.abortController.abort();
    this.clientStates.delete(client);
  }

  private async handleRawMessage(
    client: WebSocket,
    rawMessage: unknown,
  ): Promise<void> {
    const parsedMessage = parseClientMessage(rawMessage);
    if (!parsedMessage.success) {
      sendError(
        client,
        parsedMessage.requestId,
        parsedMessage.code,
        parsedMessage.code !== "INVALID_MESSAGE",
      );
      return;
    }

    if (parsedMessage.message.type === "story.cancel") {
      this.cancelStory(client, parsedMessage.message);
      return;
    }

    await this.continueStory(client, parsedMessage.message);
  }

  private async continueStory(
    client: WebSocket,
    message: StoryContinueClientMessage,
  ): Promise<void> {
    const clientState = this.clientStates.get(client);
    if (clientState === undefined) {
      sendError(client, message.requestId, "GENERATION_FAILED", true);
      return;
    }

    if (clientState.user === null) {
      sendError(client, message.requestId, "GENERATION_FAILED", true);
      return;
    }

    if (clientState.activeTask !== null) {
      sendError(client, message.requestId, "BUSY", true);
      return;
    }

    const abortController = new AbortController();
    const activeTask: ActiveRealtimeTask = {
      abortController,
      requestId: message.requestId,
    };
    clientState.activeTask = activeTask;
    sendEvent(client, {
      type: "story.started",
      requestId: message.requestId,
    });

    try {
      for await (const event of this.storylineGenerationService.streamContinueStoryline(
        {
          userId: clientState.user.sub,
          payload: message.payload,
        },
        { signal: abortController.signal },
      )) {
        if (abortController.signal.aborted) {
          return;
        }

        this.sendStoryStreamEvent(client, message.requestId, event);
      }
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        return;
      }

      sendError(client, message.requestId, mapStreamErrorCode(error), true);
    } finally {
      const latestClientState = this.clientStates.get(client);
      if (latestClientState?.activeTask?.requestId === message.requestId) {
        latestClientState.activeTask = null;
      }
    }
  }

  private cancelStory(
    client: WebSocket,
    message: StoryCancelClientMessage,
  ): void {
    const clientState = this.clientStates.get(client);
    if (clientState?.activeTask === undefined || clientState.activeTask === null) {
      sendError(client, message.requestId, "NO_ACTIVE_TASK", false);
      return;
    }

    const activeTask = clientState.activeTask;
    if (activeTask.requestId !== message.requestId) {
      sendError(client, message.requestId, "NO_ACTIVE_TASK", false);
      return;
    }

    activeTask.abortController.abort();
    clientState.activeTask = null;
    sendEvent(client, {
      type: "story.cancelled",
      requestId: message.requestId,
    });
  }

  private sendStoryStreamEvent(
    client: WebSocket,
    requestId: string,
    event: StorylineStreamEvent,
  ): void {
    if (event.type === "chunk") {
      sendEvent(client, {
        type: "story.chunk",
        requestId,
        sequence: event.sequence,
        delta: event.delta,
      });
      return;
    }

    if (event.type === "summaryStarted") {
      sendEvent(client, {
        type: "story.summary.started",
        requestId,
      });
      return;
    }

    sendEvent(client, {
      type: "story.completed",
      requestId,
      storyline: event.storyline,
      generatedSegmentId: event.generatedSegmentId,
    });
  }
}

function parseClientMessage(
  rawMessage: unknown,
):
  | Readonly<{ success: true; message: StoryRealtimeClientMessage }>
  | Readonly<{
      success: false;
      code: "INVALID_MESSAGE" | "INVALID_PAYLOAD";
      requestId: string;
    }> {
  let parsedMessage: unknown;

  try {
    const messageText = rawDataToString(rawMessage);
    parsedMessage = JSON.parse(messageText) as unknown;
  } catch {
    return { success: false, code: "INVALID_MESSAGE", requestId: "" };
  }

  const result = StoryRealtimeClientMessageSchema.safeParse(parsedMessage);
  if (result.success) {
    return { success: true, message: result.data };
  }

  return {
    success: false,
    code: "INVALID_PAYLOAD",
    requestId: getRequestIdFromUnknownMessage(parsedMessage),
  };
}

function rawDataToString(rawMessage: unknown): string {
  if (typeof rawMessage === "string") {
    return rawMessage;
  }

  if (Buffer.isBuffer(rawMessage)) {
    return rawMessage.toString("utf8");
  }

  if (Array.isArray(rawMessage)) {
    return Buffer.concat(rawMessage).toString("utf8");
  }

  if (rawMessage instanceof ArrayBuffer) {
    return Buffer.from(rawMessage).toString("utf8");
  }

  if (ArrayBuffer.isView(rawMessage)) {
    return Buffer.from(rawMessage.buffer).toString("utf8");
  }

  if (
    typeof rawMessage === "object" &&
    rawMessage !== null &&
    "data" in rawMessage
  ) {
    return rawDataToString(rawMessage.data);
  }

  throw new Error("Unsupported websocket message payload");
}

function bindClientMessageHandler(
  client: WebSocket,
  handler: (rawMessage: unknown) => void,
): void {
  client.on("message", handler);
}

function getAccessTokenFromRequest(request: IncomingMessage): string | null {
  if (request.url === undefined) {
    return null;
  }

  const url = new URL(request.url, "ws://localhost");
  const accessToken = url.searchParams.get("accessToken")?.trim();
  return accessToken !== undefined && accessToken.length > 0
    ? accessToken
    : null;
}

function sendEvent(client: WebSocket, event: StoryRealtimeServerEvent): void {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }

  client.send(JSON.stringify(event));
}

function getRequestIdFromUnknownMessage(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string"
  ) {
    return value.requestId;
  }

  return "";
}

function sendError(
  client: WebSocket,
  requestId: string,
  code: RealtimeErrorCode,
  retryable: boolean,
): void {
  sendEvent(client, {
    type: "story.error",
    requestId,
    code,
    message: errorMessages[code],
    retryable,
  });
}

function mapStreamErrorCode(error: unknown): RealtimeErrorCode {
  if (error instanceof StorylineNotFoundError) {
    return "STORYLINE_NOT_FOUND";
  }

  if (error instanceof StorylineBusyError) {
    return "STORYLINE_BUSY";
  }

  if (error instanceof StorylineSaveFailedError) {
    return "STORYLINE_SAVE_FAILED";
  }

  if (error instanceof StorySegmentNotRewritableError) {
    return "STORY_SEGMENT_NOT_REWRITABLE";
  }

  if (error instanceof StorySummaryFailedError) {
    return "STORY_SUMMARY_FAILED";
  }

  if (error instanceof BadGatewayException) {
    const response = error.getResponse();
    const message =
      typeof response === "string"
        ? response
        : typeof response === "object" &&
            response !== null &&
            "message" in response &&
            typeof response.message === "string"
          ? response.message
          : "";

    if (message.includes("empty")) {
      return "LLM_EMPTY_RESPONSE";
    }

    if (message.includes("usage")) {
      return "LLM_USAGE_MISSING";
    }
  }

  return "GENERATION_FAILED";
}
