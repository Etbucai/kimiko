import type {
  StoryCancelClientMessage,
  StoryCompletedServerEvent,
  StoryContinueClientMessage,
  StoryContinuePayload,
  StoryGenerationStreamSnapshot,
  StoryPersistedServerEvent,
  StoryRealtimeErrorCode,
  StoryRealtimeServerEvent,
  StoryResumeClientMessage,
  StorylineId,
} from "@kimiko/schema";
import { StoryRealtimeServerEventSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultGenerationErrorMessage = "生成失败，请稍后重试";
const authPolicyViolationCode = 1008;
const reconnectInitialDelayMs = 500;
const reconnectMaximumDelayMs = 5_000;
let requestSequence = 0;

export interface StoryRealtimeGenerationError {
  readonly code: StoryRealtimeErrorCode | "UNKNOWN";
  readonly message: string;
  readonly retryable: boolean;
}

export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onSnapshot: (snapshot: StoryGenerationStreamSnapshot) => void;
  onReasoning: (delta: string, sequence: number) => void;
  onChunk: (delta: string, sequence: number) => void;
  onPersisted: (event: StoryPersistedServerEvent) => void;
  onContextStarted: () => void;
  onContextFailed: (message: string) => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onReconnecting: () => void;
  onError: (error: StoryRealtimeGenerationError) => void;
  onAuthRequired: () => void;
}

export interface StoryRealtimeGenerationHandle {
  cancel: () => void;
  close: () => void;
}

type StoryRealtimeStartInput =
  | Readonly<{
      kind: "start";
      payload: StoryContinuePayload;
      requestId: string;
      storylineId: StorylineId | null;
    }>
  | Readonly<{
      kind: "resume";
      requestId: string;
      storylineId: StorylineId;
    }>;

export function startStoryRealtimeGeneration(
  payload: StoryContinuePayload,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle {
  return createStoryRealtimeGeneration(
    {
      kind: "start",
      payload,
      requestId: createRealtimeRequestId(),
      storylineId:
        payload.mode === "create" || payload.mode === "createFromSetting"
          ? null
          : payload.storylineId,
    },
    callbacks,
  );
}

export function resumeStoryRealtimeGeneration(
  input: Readonly<{
    requestId: string;
    storylineId: StorylineId;
  }>,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle {
  return createStoryRealtimeGeneration(
    {
      kind: "resume",
      requestId: input.requestId,
      storylineId: input.storylineId,
    },
    callbacks,
  );
}

function createStoryRealtimeGeneration(
  input: StoryRealtimeStartInput,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    callbacks.onAuthRequired();
    return createNoopGenerationHandle();
  }
  const accessToken = authSession.session.accessToken;

  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let isSettled = false;
  let isClosedByClient = false;
  let isCancelRequested = false;
  let hasSentInitialRequest = input.kind === "resume";
  let contentSequence = 0;
  let reasoningSequence = 0;

  connect();

  return {
    cancel() {
      if (isSettled) {
        return;
      }

      isCancelRequested = true;
      if (socket?.readyState === WebSocket.OPEN) {
        sendCancel(socket, input.requestId);
        return;
      }

      if (input.storylineId === null) {
        settleAsCancelled();
      }
    },
    close() {
      if (isSettled) {
        return;
      }

      isSettled = true;
      isClosedByClient = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };

  function connect(): void {
    if (isSettled || isClosedByClient) {
      return;
    }

    const nextSocket = new WebSocket(buildRealtimeUrl(accessToken));
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      if (isSettled || socket !== nextSocket) {
        nextSocket.close();
        return;
      }

      if (!hasSentInitialRequest && input.kind === "start") {
        hasSentInitialRequest = true;
        nextSocket.send(
          JSON.stringify({
            type: "story.continue",
            requestId: input.requestId,
            payload: input.payload,
          } satisfies StoryContinueClientMessage),
        );
      } else if (input.storylineId !== null) {
        nextSocket.send(
          JSON.stringify({
            type: "story.resume",
            requestId: input.requestId,
            storylineId: input.storylineId,
          } satisfies StoryResumeClientMessage),
        );
      }

      if (isCancelRequested) {
        sendCancel(nextSocket, input.requestId);
      }
    });

    nextSocket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (isSettled || socket !== nextSocket) {
        return;
      }

      const serverEvent = parseServerEvent(event.data);
      if (serverEvent === null) {
        settleWithError(createUnknownGenerationError());
        return;
      }

      if (serverEvent.requestId !== input.requestId) {
        return;
      }

      reconnectAttempt = 0;
      switch (serverEvent.type) {
        case "story.started":
          callbacks.onStarted();
          return;
        case "story.snapshot":
          contentSequence = serverEvent.snapshot.sequence;
          reasoningSequence = serverEvent.snapshot.reasoningSequence;
          callbacks.onSnapshot(serverEvent.snapshot);
          return;
        case "story.reasoning":
          if (
            !acceptSequence(serverEvent.sequence, reasoningSequence, reconnect)
          ) {
            return;
          }
          reasoningSequence = serverEvent.sequence;
          callbacks.onReasoning(serverEvent.delta, serverEvent.sequence);
          return;
        case "story.chunk":
          if (
            !acceptSequence(serverEvent.sequence, contentSequence, reconnect)
          ) {
            return;
          }
          contentSequence = serverEvent.sequence;
          callbacks.onChunk(serverEvent.delta, serverEvent.sequence);
          return;
        case "story.persisted":
          callbacks.onPersisted(serverEvent);
          return;
        case "story.context.started":
          callbacks.onContextStarted();
          return;
        case "story.context.failed":
          callbacks.onContextFailed(serverEvent.message);
          return;
        case "story.completed":
          isSettled = true;
          isClosedByClient = true;
          callbacks.onCompleted(serverEvent);
          nextSocket.close();
          return;
        case "story.cancelled":
          settleAsCancelled();
          return;
        case "story.error":
          settleWithError({
            code: serverEvent.code,
            message: serverEvent.message,
            retryable: serverEvent.retryable,
          });
          return;
      }
    });

    nextSocket.addEventListener("error", () => {
      // The close event owns retry decisions so error and close cannot race.
    });

    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) {
        socket = null;
      }
      if (isSettled || isClosedByClient) {
        return;
      }

      if (event.code === authPolicyViolationCode) {
        isSettled = true;
        clearAuthSession();
        callbacks.onAuthRequired();
        return;
      }

      if (isCancelRequested && input.storylineId === null) {
        settleAsCancelled();
        return;
      }

      if (input.storylineId === null) {
        settleWithError(createUnknownGenerationError());
        return;
      }

      scheduleReconnect();
    });
  }

  function reconnect(): void {
    if (isSettled || isClosedByClient) {
      return;
    }

    socket?.close();
    socket = null;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null || isSettled || isClosedByClient) {
      return;
    }

    callbacks.onReconnecting();
    const delay = Math.min(
      reconnectInitialDelayMs * 2 ** reconnectAttempt,
      reconnectMaximumDelayMs,
    );
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }

    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function settleAsCancelled(): void {
    if (isSettled) {
      return;
    }

    isSettled = true;
    isClosedByClient = true;
    clearReconnectTimer();
    callbacks.onCancelled();
    socket?.close();
    socket = null;
  }

  function settleWithError(error: StoryRealtimeGenerationError): void {
    if (isSettled) {
      return;
    }

    isSettled = true;
    isClosedByClient = true;
    clearReconnectTimer();
    callbacks.onError(error);
    socket?.close();
    socket = null;
  }
}

function acceptSequence(
  nextSequence: number,
  currentSequence: number,
  recover: () => void,
): boolean {
  if (nextSequence <= currentSequence) {
    return false;
  }

  if (nextSequence !== currentSequence + 1) {
    recover();
    return false;
  }

  return true;
}

function sendCancel(socket: WebSocket, requestId: string): void {
  socket.send(
    JSON.stringify({
      type: "story.cancel",
      requestId,
    } satisfies StoryCancelClientMessage),
  );
}

function parseServerEvent(value: unknown): StoryRealtimeServerEvent | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsedValue = JSON.parse(value) as unknown;
    const result = StoryRealtimeServerEventSchema.safeParse(parsedValue);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function buildRealtimeUrl(accessToken: string): string {
  const realtimeUrl = new URL(getRealtimeBaseUrl(API_BASE_URL));
  realtimeUrl.searchParams.set("accessToken", accessToken);
  return realtimeUrl.toString();
}

function getRealtimeBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}

function createRealtimeRequestId(): string {
  requestSequence =
    requestSequence >= Number.MAX_SAFE_INTEGER ? 1 : requestSequence + 1;

  return [
    "story",
    Date.now().toString(36),
    requestSequence.toString(36),
    Math.random().toString(36).slice(2, 10),
  ].join("-");
}

function createNoopGenerationHandle(): StoryRealtimeGenerationHandle {
  return {
    cancel: () => undefined,
    close: () => undefined,
  };
}

function createUnknownGenerationError(
  message = defaultGenerationErrorMessage,
): StoryRealtimeGenerationError {
  return {
    code: "UNKNOWN",
    message,
    retryable: true,
  };
}
