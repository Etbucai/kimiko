import type {
  CompleteStorySettingRequest,
  CreateStorySettingRequest,
  CreateStorySettingResponse,
  GenerateLlmTextStreamCompletedEvent,
  StorySetting,
  StorySettingCompletionStreamEvent,
  StorySettingId,
  StorySettingListItem,
} from "@kimiko/schema";
import {
  CreateStorySettingResponseSchema,
  GetStorySettingResponseSchema,
  ListStorySettingsResponseSchema,
  StorySettingCompletionStreamEventSchema,
} from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultListErrorMessage = "加载设定列表失败，请稍后重试";
const defaultDetailErrorMessage = "加载设定失败，请稍后重试";
const defaultSaveErrorMessage = "保存设定失败，请稍后重试";
const defaultStreamErrorMessage = "补全设定失败，请稍后重试";
const defaultNotFoundErrorMessage = "设定不存在或已不可用";

export type ListStorySettingsResult =
  | Readonly<{ status: "success"; settings: readonly StorySettingListItem[] }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function listStorySettings(): Promise<ListStorySettingsResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/story-settings`, {
      headers: {
        Authorization: `Bearer ${authSession.session.accessToken}`,
      },
      method: "GET",
    });

    if (response.status === 401) {
      clearAuthSession();
      return { status: "authRequired" };
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      return {
        status: "failed",
        message: defaultListErrorMessage,
      };
    }

    const result = ListStorySettingsResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultListErrorMessage,
      };
    }

    return {
      status: "success",
      settings: result.data.settings,
    };
  } catch {
    return {
      status: "failed",
      message: defaultListErrorMessage,
    };
  }
}

export type GetStorySettingResult =
  | Readonly<{ status: "success"; setting: StorySetting }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStorySetting(
  settingId: StorySettingId,
): Promise<GetStorySettingResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/story-settings/${encodeURIComponent(settingId)}`,
      {
        headers: {
          Authorization: `Bearer ${authSession.session.accessToken}`,
        },
        method: "GET",
      },
    );

    if (response.status === 401) {
      clearAuthSession();
      return { status: "authRequired" };
    }

    if (response.status === 404) {
      return {
        status: "notFound",
        message: defaultNotFoundErrorMessage,
      };
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      return {
        status: "failed",
        message: defaultDetailErrorMessage,
      };
    }

    const result = GetStorySettingResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultDetailErrorMessage,
      };
    }

    return {
      status: "success",
      setting: result.data.setting,
    };
  } catch {
    return {
      status: "failed",
      message: defaultDetailErrorMessage,
    };
  }
}

export type CreateStorySettingResult =
  | Readonly<{ status: "success"; setting: CreateStorySettingResponse["setting"] }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function createStorySetting(
  request: CreateStorySettingRequest,
): Promise<CreateStorySettingResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/story-settings`, {
      body: JSON.stringify(request),
      headers: {
        Authorization: `Bearer ${authSession.session.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (response.status === 401) {
      clearAuthSession();
      return { status: "authRequired" };
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      return {
        status: "failed",
        message: defaultSaveErrorMessage,
      };
    }

    const result = CreateStorySettingResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultSaveErrorMessage,
      };
    }

    return {
      status: "success",
      setting: result.data.setting,
    };
  } catch {
    return {
      status: "failed",
      message: defaultSaveErrorMessage,
    };
  }
}

export interface StorySettingCompletionCallbacks {
  onStarted: () => void;
  onReasoningChunk: (delta: string, sequence: number) => void;
  onChunk: (delta: string, sequence: number) => void;
  onCompleted: (event: GenerateLlmTextStreamCompletedEvent) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

export interface StorySettingCompletionHandle {
  cancel: () => void;
  close: () => void;
}

export function startStorySettingCompletionStream(
  request: CompleteStorySettingRequest,
  callbacks: StorySettingCompletionCallbacks,
): StorySettingCompletionHandle {
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
      const response = await fetch(
        `${API_BASE_URL}/story-settings/complete/stream`,
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
      case "reasoning_chunk":
        callbacks.onReasoningChunk(event.delta, event.sequence);
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

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function parseStreamEvent(
  value: string,
): StorySettingCompletionStreamEvent | null {
  try {
    const parsedValue = JSON.parse(value) as unknown;
    const result =
      StorySettingCompletionStreamEventSchema.safeParse(parsedValue);
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

function createNoopStreamHandle(): StorySettingCompletionHandle {
  return {
    cancel: () => undefined,
    close: () => undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
