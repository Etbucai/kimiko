import type {
  GenerateLlmTextRequest,
  GenerateLlmTextStreamCompletedEvent,
  GenerateLlmTextStreamEvent,
} from "@kimiko/schema";
import { GenerateLlmTextStreamEventSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultStreamErrorMessage = "生成失败，请稍后重试";

export interface LlmTextStreamCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onCompleted: (event: GenerateLlmTextStreamCompletedEvent) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

export interface LlmTextStreamHandle {
  cancel: () => void;
  close: () => void;
}

export function startLlmTextStream(
  request: GenerateLlmTextRequest,
  callbacks: LlmTextStreamCallbacks,
): LlmTextStreamHandle {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    callbacks.onAuthRequired();
    return createNoopStreamHandle();
  }

  const accessToken = authSession.session.accessToken;
  const abortController = new AbortController();
  let isSettled = false;
  let isClosedByClient = false;
  let isCancelRequested = false;

  void consumeStream();

  return {
    cancel() {
      if (isSettled) {
        return;
      }

      isCancelRequested = true;
      abortController.abort();
    },
    close() {
      isSettled = true;
      isClosedByClient = true;
      abortController.abort();
    },
  };

  async function consumeStream(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/llm/generate/stream`, {
        body: JSON.stringify(request),
        headers: {
          Accept: "application/x-ndjson",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: abortController.signal,
      });

      if (isSettled || isClosedByClient) {
        return;
      }

      if (response.status === 401) {
        isSettled = true;
        isClosedByClient = true;
        clearAuthSession();
        callbacks.onAuthRequired();
        return;
      }

      if (!response.ok) {
        settleWithError(await getResponseErrorMessage(response));
        return;
      }

      if (response.body === null) {
        settleWithError(defaultStreamErrorMessage);
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
          const shouldContinue = handleStreamLine(line);
          if (!shouldContinue) {
            await reader.cancel();
            return;
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        handleStreamLine(buffer);
      }

      if (isSettled || isClosedByClient) {
        return;
      }

      if (abortController.signal.aborted && isCancelRequested) {
        isSettled = true;
        callbacks.onCancelled();
        return;
      }

      settleWithError(defaultStreamErrorMessage);
    } catch (error: unknown) {
      if (isSettled || isClosedByClient) {
        return;
      }

      if (abortController.signal.aborted && isCancelRequested) {
        isSettled = true;
        callbacks.onCancelled();
        return;
      }

      settleWithError(getErrorMessage(error));
    }
  }

  function handleStreamLine(line: string): boolean {
    if (isSettled || isClosedByClient) {
      return false;
    }

    const event = parseStreamEvent(line);
    if (event === null) {
      settleWithError(defaultStreamErrorMessage);
      return false;
    }

    switch (event.type) {
      case "started":
        callbacks.onStarted();
        return true;
      case "chunk":
        callbacks.onChunk(event.delta, event.sequence);
        return true;
      case "completed":
        isSettled = true;
        callbacks.onCompleted(event);
        return false;
      case "error":
        settleWithError(event.message);
        return false;
    }
  }

  function settleWithError(message: string): void {
    if (isSettled || isClosedByClient) {
      return;
    }

    isSettled = true;
    callbacks.onError(message);
  }
}

function parseStreamEvent(value: string): GenerateLlmTextStreamEvent | null {
  try {
    const parsedValue = JSON.parse(value) as unknown;
    const result = GenerateLlmTextStreamEventSchema.safeParse(parsedValue);
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

async function getResponseErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return `请求失败 (${response.status})`;
    }

    const parsedBody = JSON.parse(text) as unknown;
    if (
      isRecord(parsedBody) &&
      typeof parsedBody.message === "string" &&
      parsedBody.message.length > 0
    ) {
      return parsedBody.message;
    }

    return `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return defaultStreamErrorMessage;
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}

function createNoopStreamHandle(): LlmTextStreamHandle {
  return {
    cancel: () => undefined,
    close: () => undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
