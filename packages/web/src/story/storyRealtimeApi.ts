import type {
  ContinueStoryRequest,
  StoryCancelClientMessage,
  StoryCompletedServerEvent,
  StoryContinueClientMessage,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import { StoryRealtimeServerEventSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultGenerationErrorMessage = "生成失败，请稍后重试";
const authPolicyViolationCode = 1008;

export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

export interface StoryRealtimeGenerationHandle {
  cancel: () => void;
  close: () => void;
}

export function startStoryRealtimeGeneration(
  request: ContinueStoryRequest,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    callbacks.onAuthRequired();
    return createNoopGenerationHandle();
  }

  const requestId = crypto.randomUUID();
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
        payload: request,
      } satisfies StoryContinueClientMessage),
    );
  });

  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isSettled) {
      return;
    }

    const serverEvent = parseServerEvent(event.data);
    if (serverEvent === null) {
      settleWithError(defaultGenerationErrorMessage);
      return;
    }

    if (serverEvent.requestId !== requestId) {
      return;
    }

    switch (serverEvent.type) {
      case "story.started":
        callbacks.onStarted();
        return;
      case "story.chunk":
        callbacks.onChunk(serverEvent.delta, serverEvent.sequence);
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
        settleWithError(serverEvent.message);
        return;
    }
  });

  socket.addEventListener("error", () => {
    if (!isSettled) {
      settleWithError(defaultGenerationErrorMessage);
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
    callbacks.onError(defaultGenerationErrorMessage);
  });

  function settleWithError(message: string): void {
    if (isSettled) {
      return;
    }

    isSettled = true;
    isClosedByClient = true;
    callbacks.onError(message);
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

function createNoopGenerationHandle(): StoryRealtimeGenerationHandle {
  return {
    cancel: () => undefined,
    close: () => undefined,
  };
}
