import { BadGatewayException, Injectable, Logger } from "@nestjs/common";
import { WebSocketGateway } from "@nestjs/websockets";
import type { OnGatewayDisconnect, OnGatewayInit } from "@nestjs/websockets";
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
  StoryContextFailedError,
  StorySegmentNotRewritableError,
  StorylineBusyError,
  StorylineNotFoundError,
  StorylineSaveFailedError,
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
  STORY_CONTEXT_FAILED: "生成失败，请稍后重试",
  STORY_SEGMENT_NOT_REWRITABLE: "当前段落不可重写",
};

@Injectable()
@WebSocketGateway({ path: "/realtime" })
export class RealtimeGateway
  implements OnGatewayInit<WebSocketServer>, OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(RealtimeGateway.name);
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
      this.logger.warn(
        JSON.stringify({
          event: "story_realtime_connection_rejected",
          reason: "missing_access_token",
          remoteAddress: request.socket.remoteAddress,
        }),
      );
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
      this.logger.log(
        JSON.stringify({
          event: "story_realtime_connection_accepted",
          remoteAddress: request.socket.remoteAddress,
          userId: payload.sub,
        }),
      );
      client.once("close", (code, reason) => {
        this.cleanupClient(client, {
          closeCode: code,
          closeReason: reason.toString("utf8"),
          event: "story_realtime_connection_closed",
        });
      });
      bindClientMessageHandler(client, (rawMessage) => {
        void this.handleRawMessage(client, rawMessage);
      });
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          error: toLoggableError(error),
          event: "story_realtime_connection_rejected",
          reason: "invalid_access_token",
          remoteAddress: request.socket.remoteAddress,
        }),
      );
      client.close(unauthorizedCloseCode, unauthorizedCloseReason);
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.cleanupClient(client, {
      event: "story_realtime_gateway_disconnect",
    });
  }

  private async handleRawMessage(
    client: WebSocket,
    rawMessage: unknown,
  ): Promise<void> {
    const parsedMessage = parseClientMessage(rawMessage);
    if (!parsedMessage.success) {
      this.logger.warn(
        JSON.stringify({
          code: parsedMessage.code,
          event: "story_realtime_message_rejected",
          requestId: parsedMessage.requestId,
        }),
      );
      sendError(
        client,
        parsedMessage.requestId,
        parsedMessage.code,
        parsedMessage.code !== "INVALID_MESSAGE",
      );
      return;
    }

    this.logger.log(
      JSON.stringify({
        event: "story_realtime_message_received",
        messageType: parsedMessage.message.type,
        payloadMode:
          parsedMessage.message.type === "story.continue"
            ? parsedMessage.message.payload.mode
            : undefined,
        requestId: parsedMessage.message.requestId,
        storylineId:
          parsedMessage.message.type === "story.continue"
            ? getStorylineIdFromPayload(parsedMessage.message.payload)
            : undefined,
      }),
    );

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
      this.logger.warn(
        JSON.stringify({
          event: "story_realtime_continue_rejected",
          reason: "missing_client_state",
          requestId: message.requestId,
        }),
      );
      sendError(client, message.requestId, "GENERATION_FAILED", true);
      return;
    }

    if (clientState.user === null) {
      this.logger.warn(
        JSON.stringify({
          event: "story_realtime_continue_rejected",
          reason: "missing_user",
          requestId: message.requestId,
        }),
      );
      sendError(client, message.requestId, "GENERATION_FAILED", true);
      return;
    }

    if (clientState.activeTask !== null) {
      this.logger.warn(
        JSON.stringify({
          activeRequestId: clientState.activeTask.requestId,
          event: "story_realtime_continue_rejected",
          reason: "client_busy",
          requestId: message.requestId,
          userId: clientState.user.sub,
        }),
      );
      sendError(client, message.requestId, "BUSY", true);
      return;
    }

    const startedAt = Date.now();
    const payloadMode = message.payload.mode;
    const storylineId = getStorylineIdFromPayload(message.payload);
    let chunkChars = 0;
    let chunkCount = 0;
    let terminalEvent: StorylineStreamEvent["type"] | null = null;

    const abortController = new AbortController();
    const activeTask: ActiveRealtimeTask = {
      abortController,
      requestId: message.requestId,
    };
    clientState.activeTask = activeTask;
    this.logger.log(
      JSON.stringify({
        event: "story_realtime_task_started",
        payloadMode,
        requestId: message.requestId,
        storylineId,
        userId: clientState.user.sub,
      }),
    );
    sendEvent(client, {
      type: "story.started",
      requestId: message.requestId,
    });
    this.logger.log(
      JSON.stringify({
        elapsedMs: getElapsedMs(startedAt),
        event: "story_realtime_started_sent",
        payloadMode,
        requestId: message.requestId,
        storylineId,
        userId: clientState.user.sub,
      }),
    );

    try {
      for await (const event of this.storylineGenerationService.streamContinueStoryline(
        {
          requestId: message.requestId,
          userId: clientState.user.sub,
          payload: message.payload,
        },
        { signal: abortController.signal },
      )) {
        if (abortController.signal.aborted) {
          this.logger.log(
            JSON.stringify({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              event: "story_realtime_task_aborted",
              payloadMode,
              requestId: message.requestId,
              storylineId,
              userId: clientState.user.sub,
            }),
          );
          return;
        }

        this.sendStoryStreamEvent(client, message.requestId, event);
        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logger.log(
              JSON.stringify({
                chunkChars,
                elapsedMs: getElapsedMs(startedAt),
                event: "story_realtime_first_chunk_sent",
                payloadMode,
                requestId: message.requestId,
                sequence: event.sequence,
                storylineId,
                userId: clientState.user.sub,
              }),
            );
          }
          continue;
        }

        terminalEvent = event.type;
        this.logger.log(
          JSON.stringify({
            chunkChars,
            chunkCount,
            elapsedMs: getElapsedMs(startedAt),
            event:
              event.type === "contextStarted"
                ? "story_realtime_context_started_sent"
                : "story_realtime_completed_sent",
            generatedSegmentId:
              event.type === "completed" ? event.generatedSegmentId : undefined,
            payloadMode,
            requestId: message.requestId,
            storylineId,
            userId: clientState.user.sub,
          }),
        );
      }

      if (!abortController.signal.aborted && terminalEvent !== "completed") {
        this.logger.error(
          JSON.stringify({
            chunkChars,
            chunkCount,
            elapsedMs: getElapsedMs(startedAt),
            event: "story_realtime_stream_ended_without_terminal_event",
            lastEvent: terminalEvent,
            payloadMode,
            requestId: message.requestId,
            storylineId,
            userId: clientState.user.sub,
          }),
        );
        sendError(client, message.requestId, "GENERATION_FAILED", true);
      }
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        this.logger.log(
          JSON.stringify({
            chunkChars,
            chunkCount,
            elapsedMs: getElapsedMs(startedAt),
            event: "story_realtime_task_aborted",
            payloadMode,
            requestId: message.requestId,
            storylineId,
            userId: clientState.user.sub,
          }),
        );
        return;
      }

      const errorCode = mapStreamErrorCode(error);
      this.logger.error(
        JSON.stringify({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          errorCode,
          event: "story_realtime_generation_failed",
          error: toLoggableError(error),
          payloadMode,
          requestId: message.requestId,
          retryable: true,
          storylineId,
          userId: clientState.user.sub,
        }),
      );
      sendError(client, message.requestId, errorCode, true);
    } finally {
      const latestClientState = this.clientStates.get(client);
      if (latestClientState?.activeTask?.requestId === message.requestId) {
        latestClientState.activeTask = null;
      }
      this.logger.log(
        JSON.stringify({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          event: "story_realtime_task_finished",
          payloadMode,
          requestId: message.requestId,
          storylineId,
          terminalEvent,
          userId: clientState.user.sub,
        }),
      );
    }
  }

  private cancelStory(
    client: WebSocket,
    message: StoryCancelClientMessage,
  ): void {
    const clientState = this.clientStates.get(client);
    if (
      clientState?.activeTask === undefined ||
      clientState.activeTask === null
    ) {
      this.logger.warn(
        JSON.stringify({
          event: "story_realtime_cancel_rejected",
          reason: "no_active_task",
          requestId: message.requestId,
          userId: clientState?.user?.sub,
        }),
      );
      sendError(client, message.requestId, "NO_ACTIVE_TASK", false);
      return;
    }

    const activeTask = clientState.activeTask;
    if (activeTask.requestId !== message.requestId) {
      this.logger.warn(
        JSON.stringify({
          activeRequestId: activeTask.requestId,
          event: "story_realtime_cancel_rejected",
          reason: "request_id_mismatch",
          requestId: message.requestId,
          userId: clientState.user?.sub,
        }),
      );
      sendError(client, message.requestId, "NO_ACTIVE_TASK", false);
      return;
    }

    activeTask.abortController.abort();
    clientState.activeTask = null;
    this.logger.log(
      JSON.stringify({
        event: "story_realtime_cancelled",
        requestId: message.requestId,
        userId: clientState.user?.sub,
      }),
    );
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

    if (event.type === "contextStarted") {
      sendEvent(client, {
        type: "story.context.started",
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

  private cleanupClient(
    client: WebSocket,
    input: Readonly<{
      closeCode?: number;
      closeReason?: string;
      event:
        | "story_realtime_connection_closed"
        | "story_realtime_gateway_disconnect";
    }>,
  ): void {
    const clientState = this.clientStates.get(client);
    if (clientState === undefined) {
      return;
    }

    const activeRequestId = clientState.activeTask?.requestId;
    clientState.activeTask?.abortController.abort();
    this.clientStates.delete(client);
    this.logger.log(
      JSON.stringify({
        activeRequestId,
        closeCode: input.closeCode,
        closeReason: input.closeReason,
        event: input.event,
        hadActiveTask: activeRequestId !== undefined,
        userId: clientState.user?.sub,
      }),
    );
  }
}

function getStorylineIdFromPayload(
  payload: StoryContinueClientMessage["payload"],
): string | null {
  return payload.mode === "create" ? null : payload.storylineId;
}

function parseClientMessage(rawMessage: unknown):
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

function getElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
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

  if (error instanceof StoryContextFailedError) {
    return "STORY_CONTEXT_FAILED";
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

function toLoggableError(error: unknown): Readonly<{
  message: string;
  name: string;
  stack?: string;
}> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
