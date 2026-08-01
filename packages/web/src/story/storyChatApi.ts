import type {
  StoryChapterChatRequest,
  StoryChapterChatStreamEvent,
  StorylineId,
} from "@kimiko/schema";
import { StoryChapterChatStreamEventSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultChatErrorMessage = "AI 回答失败，请稍后重试";

export interface StoryChapterChatError {
  readonly code:
    | "INVALID_REQUEST"
    | "RESOURCE_NOT_FOUND"
    | "STORYLINE_BUSY"
    | "CHAT_CONTEXT_TOO_LARGE"
    | "LLM_EMPTY_RESPONSE"
    | "CHAT_FAILED"
    | "UNKNOWN";
  readonly message: string;
  readonly retryable: boolean;
}

export interface StoryChapterChatCallbacks {
  onStarted(): void;
  onReasoningChunk(delta: string, sequence: number): void;
  onAnswerChunk(delta: string, sequence: number): void;
  onCompleted(): void;
  onCancelled(): void;
  onError(error: StoryChapterChatError): void;
  onAuthRequired(): void;
}

export interface StoryChapterChatHandle {
  cancel(): void;
  close(): void;
}

export function startStoryChapterChat(
  storylineId: StorylineId,
  request: StoryChapterChatRequest,
  callbacks: StoryChapterChatCallbacks,
): StoryChapterChatHandle {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    callbacks.onAuthRequired();
    return createNoopHandle();
  }

  const abortController = new AbortController();
  let isCancelRequested = false;
  let isClosedByClient = false;
  let isSettled = false;
  let hasStarted = false;
  let lastAnswerSequence = 0;
  let lastReasoningSequence = 0;

  void consumeStream(authSession.session.accessToken);

  return {
    cancel() {
      if (isSettled || isClosedByClient) {
        return;
      }

      isCancelRequested = true;
      abortController.abort();
    },
    close() {
      if (isSettled || isClosedByClient) {
        return;
      }

      isClosedByClient = true;
      isSettled = true;
      abortController.abort();
    },
  };

  async function consumeStream(accessToken: string): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/chat/stream`,
        {
          body: JSON.stringify(request),
          headers: {
            Accept: "application/x-ndjson",
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: abortController.signal,
        },
      );

      if (isSettled || isClosedByClient) {
        return;
      }

      if (response.status === 401) {
        isSettled = true;
        clearAuthSession();
        callbacks.onAuthRequired();
        return;
      }

      if (!response.ok) {
        settleWithError(mapHttpError(response.status));
        return;
      }

      if (response.body === null) {
        settleWithError(createUnknownError());
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsedLines = parseBufferLines(buffer);
        buffer = parsedLines.rest;

        for (const line of parsedLines.lines) {
          if (!handleStreamLine(line)) {
            await reader.cancel();
            return;
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0 && !handleStreamLine(buffer)) {
        return;
      }

      if (isSettled || isClosedByClient) {
        return;
      }

      if (abortController.signal.aborted && isCancelRequested) {
        settleWithCancellation();
        return;
      }

      settleWithError(createUnknownError());
    } catch {
      if (isSettled || isClosedByClient) {
        return;
      }

      if (abortController.signal.aborted && isCancelRequested) {
        settleWithCancellation();
        return;
      }

      settleWithError(createUnknownError("网络连接失败，请稍后重试"));
    }
  }

  function handleStreamLine(line: string): boolean {
    if (isSettled || isClosedByClient) {
      return false;
    }

    const event = parseStreamEvent(line);
    if (event === null) {
      settleWithError(createUnknownError());
      return false;
    }

    if (event.type === "started") {
      if (hasStarted) {
        settleWithError(createUnknownError());
        return false;
      }

      hasStarted = true;
      callbacks.onStarted();
      return true;
    }

    if (!hasStarted) {
      settleWithError(createUnknownError());
      return false;
    }

    switch (event.type) {
      case "reasoning_chunk":
        if (event.sequence !== lastReasoningSequence + 1) {
          settleWithError(createUnknownError());
          return false;
        }
        lastReasoningSequence = event.sequence;
        callbacks.onReasoningChunk(event.delta, event.sequence);
        return true;
      case "answer_chunk":
        if (event.sequence !== lastAnswerSequence + 1) {
          settleWithError(createUnknownError());
          return false;
        }
        lastAnswerSequence = event.sequence;
        callbacks.onAnswerChunk(event.delta, event.sequence);
        return true;
      case "completed":
        isSettled = true;
        callbacks.onCompleted();
        return false;
      case "error":
        settleWithError({
          code: event.code,
          message: event.message,
          retryable: true,
        });
        return false;
    }
  }

  function settleWithCancellation(): void {
    if (isSettled || isClosedByClient) {
      return;
    }

    isSettled = true;
    callbacks.onCancelled();
  }

  function settleWithError(error: StoryChapterChatError): void {
    if (isSettled || isClosedByClient) {
      return;
    }

    isSettled = true;
    callbacks.onError(error);
  }
}

function parseStreamEvent(value: string): StoryChapterChatStreamEvent | null {
  try {
    const parsedValue = JSON.parse(value) as unknown;
    const result = StoryChapterChatStreamEventSchema.safeParse(parsedValue);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseBufferLines(input: string): Readonly<{
  lines: readonly string[];
  rest: string;
}> {
  const parts = input.split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts.map((line) => line.trim()).filter((line) => line.length > 0),
    rest,
  };
}

function mapHttpError(status: number): StoryChapterChatError {
  switch (status) {
    case 400:
      return {
        code: "INVALID_REQUEST",
        message: "当前输入或章节不可用，请检查后重试",
        retryable: false,
      };
    case 404:
      return {
        code: "RESOURCE_NOT_FOUND",
        message: "故事或当前章节不可用，请刷新后重试",
        retryable: false,
      };
    case 409:
      return {
        code: "STORYLINE_BUSY",
        message: "当前故事正在处理中，请稍后重试",
        retryable: true,
      };
    case 413:
      return {
        code: "CHAT_CONTEXT_TOO_LARGE",
        message: "当前故事材料过长，暂时无法与 AI 聊聊",
        retryable: false,
      };
    default:
      return createUnknownError();
  }
}

function createUnknownError(
  message = defaultChatErrorMessage,
): StoryChapterChatError {
  return {
    code: "UNKNOWN",
    message,
    retryable: true,
  };
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}

function createNoopHandle(): StoryChapterChatHandle {
  return {
    cancel: () => undefined,
    close: () => undefined,
  };
}
