import type {
  StoryCancelClientMessage,
  StoryCompletedServerEvent,
  StoryContinueClientMessage,
  StoryContinuePayload,
  StoryRealtimeErrorCode,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import { StoryRealtimeServerEventSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultGenerationErrorMessage = "生成失败，请稍后重试";
const authPolicyViolationCode = 1008;
let requestSequence = 0;

export interface StoryRealtimeGenerationError {
  readonly code: StoryRealtimeErrorCode | "UNKNOWN";
  readonly message: string;
  readonly retryable: boolean;
}

export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onReasoning: (delta: string, sequence: number) => void;
  onChunk: (delta: string, sequence: number) => void;
  onContextStarted: () => void;
  onContextFailed: (message: string) => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onError: (error: StoryRealtimeGenerationError) => void;
  onAuthRequired: () => void;
}

export interface StoryRealtimeGenerationHandle {
  cancel: () => void;
  close: () => void;
}

export function startStoryRealtimeGeneration(
  payload: StoryContinuePayload,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    callbacks.onAuthRequired();
    return createNoopGenerationHandle();
  }

  const requestId = createRealtimeRequestId();
  const socket = new WebSocket(
    buildRealtimeUrl(authSession.session.accessToken),
  );
  let isSettled = false;
  let isClosedByClient = false;
  let isCancelRequested = false;

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId,
        payload,
      } satisfies StoryContinueClientMessage),
    );
  });

  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isSettled) {
      return;
    }

    const serverEvent = parseServerEvent(event.data);
    if (serverEvent === null) {
      settleWithError(createUnknownGenerationError());
      return;
    }

    if (serverEvent.requestId !== requestId) {
      return;
    }

    switch (serverEvent.type) {
      case "story.started":
        callbacks.onStarted();
        return;
      case "story.reasoning":
        callbacks.onReasoning(serverEvent.delta, serverEvent.sequence);
        return;
      case "story.chunk":
        callbacks.onChunk(serverEvent.delta, serverEvent.sequence);
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
        socket.close();
        return;
      case "story.cancelled":
        isSettled = true;
        isClosedByClient = true;
        callbacks.onCancelled();
        socket.close();
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

  socket.addEventListener("error", () => {
    if (!isSettled) {
      settleWithError(createUnknownGenerationError());
    }
  });

  socket.addEventListener("close", (event) => {
    if (isSettled || isClosedByClient) {
      return;
    }

    if (event.code === authPolicyViolationCode) {
      isSettled = true;
      clearAuthSession();
      callbacks.onAuthRequired();
      return;
    }

    if (isCancelRequested) {
      isSettled = true;
      callbacks.onCancelled();
      return;
    }

    isSettled = true;
    callbacks.onError(createUnknownGenerationError());
  });

  function settleWithError(error: StoryRealtimeGenerationError): void {
    if (isSettled) {
      return;
    }

    isSettled = true;
    isClosedByClient = true;
    callbacks.onError(error);
    socket.close();
  }

  return {
    cancel() {
      if (isSettled) {
        return;
      }

      isCancelRequested = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "story.cancel",
            requestId,
          } satisfies StoryCancelClientMessage),
        );
        return;
      }

      isSettled = true;
      isClosedByClient = true;
      callbacks.onCancelled();
      socket.close();
    },
    close() {
      isSettled = true;
      isClosedByClient = true;
      socket.close();
    },
  };
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
