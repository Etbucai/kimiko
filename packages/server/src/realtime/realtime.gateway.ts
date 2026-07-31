import { Injectable, Logger } from "@nestjs/common";
import { WebSocketGateway } from "@nestjs/websockets";
import type { OnGatewayDisconnect, OnGatewayInit } from "@nestjs/websockets";
import type {
  StoryCancelClientMessage,
  StoryContinueClientMessage,
  StoryTargetLength,
  StoryRealtimeClientMessage,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import { StoryRealtimeClientMessageSchema } from "@kimiko/schema";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { verifyAccessToken } from "../auth/jwt-auth.utils";
import { StoryGenerationTaskService } from "../storyline/story-generation-task.service";
import type { StoryGenerationObserver } from "../storyline/story-generation-task.types";
import type { RealtimeClientState, RealtimeErrorCode } from "./realtime.types";
import { getRealtimeErrorMessage } from "./realtime-error.utils";

const unauthorizedCloseCode = 1008;
const unauthorizedCloseReason = "Unauthorized";

@Injectable()
@WebSocketGateway({ path: "/realtime" })
export class RealtimeGateway
  implements OnGatewayInit<WebSocketServer>, OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly clientStates = new WeakMap<WebSocket, RealtimeClientState>();

  constructor(private readonly taskService: StoryGenerationTaskService) {}

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
        settingId:
          parsedMessage.message.type === "story.continue"
            ? getSettingIdFromPayload(parsedMessage.message.payload)
            : undefined,
        targetLength:
          parsedMessage.message.type === "story.continue"
            ? getTargetLengthFromPayload(parsedMessage.message.payload)
            : undefined,
      }),
    );

    if (parsedMessage.message.type === "story.cancel") {
      this.cancelStory(client, parsedMessage.message);
      return;
    }

    this.continueStory(client, parsedMessage.message);
  }

  private continueStory(
    client: WebSocket,
    message: StoryContinueClientMessage,
  ): void {
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

    const payloadMode = message.payload.mode;
    const storylineId = getStorylineIdFromPayload(message.payload);

    const observer = this.createObserver(client, message.requestId);
    const startResult = this.taskService.start({
      observer,
      payload: message.payload,
      requestId: message.requestId,
      userId: clientState.user.sub,
    });
    if (startResult.status === "busy") {
      this.logger.warn(
        JSON.stringify({
          event: "story_realtime_continue_rejected",
          payloadMode,
          reason:
            startResult.code === "BUSY" ? "client_busy" : "storyline_busy",
          requestId: message.requestId,
          storylineId,
          userId: clientState.user.sub,
        }),
      );
      sendError(client, message.requestId, startResult.code, true);
      return;
    }

    clientState.activeTask = {
      requestId: message.requestId,
    };
    this.logger.log(
      JSON.stringify({
        event: "story_realtime_task_started",
        payloadMode,
        requestId: message.requestId,
        settingId: getSettingIdFromPayload(message.payload),
        storylineId,
        targetLength: getTargetLengthFromPayload(message.payload),
        userId: clientState.user.sub,
      }),
    );
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

    const cancelResult = this.taskService.cancelByRequest({
      activeRequestId: activeTask.requestId,
      requestId: message.requestId,
      userId: clientState.user?.sub ?? "",
    });
    if (cancelResult.status === "noActiveTask") {
      this.logger.warn(
        JSON.stringify({
          activeRequestId: activeTask.requestId,
          event: "story_realtime_cancel_rejected",
          reason: "task_not_found",
          requestId: message.requestId,
          userId: clientState.user?.sub,
        }),
      );
      sendError(client, message.requestId, "NO_ACTIVE_TASK", false);
      return;
    }

    if (cancelResult.status === "cancelled") {
      clientState.activeTask = null;
    }
  }

  private createObserver(
    client: WebSocket,
    requestId: string,
  ): StoryGenerationObserver {
    return {
      requestId,
      sendStarted: () => {
        sendEvent(client, {
          type: "story.started",
          requestId,
        });
      },
      sendChunk: (event) => {
        sendEvent(client, {
          type: "story.chunk",
          requestId,
          sequence: event.sequence,
          delta: event.delta,
        });
      },
      sendContextStarted: () => {
        sendEvent(client, {
          type: "story.context.started",
          requestId,
        });
      },
      sendCompleted: (event) => {
        sendEvent(client, {
          type: "story.completed",
          requestId,
          storyline: event.storyline,
          generatedSegmentId: event.generatedSegmentId,
        });
        const clientState = this.clientStates.get(client);
        if (clientState?.activeTask?.requestId === requestId) {
          clientState.activeTask = null;
        }
      },
      sendCancelled: () => {
        sendEvent(client, {
          type: "story.cancelled",
          requestId,
        });
        const clientState = this.clientStates.get(client);
        if (clientState?.activeTask?.requestId === requestId) {
          clientState.activeTask = null;
        }
      },
      sendError: (error) => {
        sendEvent(client, {
          type: "story.error",
          requestId,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
        const clientState = this.clientStates.get(client);
        if (clientState?.activeTask?.requestId === requestId) {
          clientState.activeTask = null;
        }
      },
    };
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
    if (activeRequestId !== undefined && clientState.user !== null) {
      this.taskService.detachObserver({
        requestId: activeRequestId,
        userId: clientState.user.sub,
        ...(input.closeCode !== undefined
          ? { closeCode: input.closeCode }
          : {}),
        ...(input.closeReason !== undefined
          ? { closeReason: input.closeReason }
          : {}),
      });
    }
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
  return payload.mode === "create" || payload.mode === "createFromSetting"
    ? null
    : payload.storylineId;
}

function getSettingIdFromPayload(
  payload: StoryContinueClientMessage["payload"],
): string | undefined {
  return payload.mode === "createFromSetting" ? payload.settingId : undefined;
}

function getTargetLengthFromPayload(
  payload: StoryContinueClientMessage["payload"],
): StoryTargetLength | undefined {
  return payload.mode === "append" ? payload.targetLength : undefined;
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
    message: getRealtimeErrorMessage(code),
    retryable,
  });
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
