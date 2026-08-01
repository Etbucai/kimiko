import type {
  CancelStoryGenerationResponse,
  StoryGenerationStatusResponse,
  StoryContextSnapshot,
  StoryContextExtractionState,
  StoryContextExtractionTask,
  StorylineListItem,
  StorylineId,
  StorylineSnapshot,
} from "@kimiko/schema";
import {
  CancelStoryGenerationResponseSchema,
  GetStorylineContextResponseSchema,
  GetStorylineResponseSchema,
  GetRecentStorylineResponseSchema,
  ListStorylinesResponseSchema,
  STORYLINE_CHAPTER_CACHE_RADIUS,
  StoryGenerationStatusResponseSchema,
  StoryContextExtractionTaskResponseSchema,
} from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultListErrorMessage = "加载故事列表失败，请稍后重试";
const defaultRestoreErrorMessage = "恢复故事线失败，请稍后重试";
const defaultNotFoundErrorMessage = "故事线不存在或已不可用";
const defaultContextErrorMessage = "获取故事上下文失败，请稍后重试";
const defaultContextExtractionErrorMessage = "上下文提取失败，请稍后重试";
const defaultGenerationStatusErrorMessage = "获取后台生成状态失败，请稍后重试";
const defaultGenerationCancelErrorMessage = "取消后台生成失败，请稍后重试";

export type ListStorylinesResult =
  | Readonly<{ status: "success"; storylines: readonly StorylineListItem[] }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function listStorylines(): Promise<ListStorylinesResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/storylines`, {
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

    const result = ListStorylinesResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultListErrorMessage,
      };
    }

    return {
      status: "success",
      storylines: result.data.storylines,
    };
  } catch {
    return {
      status: "failed",
      message: defaultListErrorMessage,
    };
  }
}

export type GetRecentStorylineResult =
  | Readonly<{ status: "success"; storyline: StorylineSnapshot | null }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export interface StorylineWindowQuery {
  readonly anchorPage: number | "latest";
  readonly before: number;
  readonly after: number;
}

const defaultStorylineWindowQuery: StorylineWindowQuery = {
  anchorPage: "latest",
  before: STORYLINE_CHAPTER_CACHE_RADIUS,
  after: STORYLINE_CHAPTER_CACHE_RADIUS,
};

export async function getRecentStoryline(
  query: StorylineWindowQuery = defaultStorylineWindowQuery,
): Promise<GetRecentStorylineResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      buildStorylineWindowUrl("/storylines/recent", query),
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

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      return {
        status: "failed",
        message: defaultRestoreErrorMessage,
      };
    }

    const result = GetRecentStorylineResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultRestoreErrorMessage,
      };
    }

    return {
      status: "success",
      storyline: result.data.storyline,
    };
  } catch {
    return {
      status: "failed",
      message: defaultRestoreErrorMessage,
    };
  }
}

export type GetStorylineResult =
  | Readonly<{ status: "success"; storyline: StorylineSnapshot }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStoryline(
  storylineId: StorylineId,
  query: StorylineWindowQuery = defaultStorylineWindowQuery,
): Promise<GetStorylineResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      buildStorylineWindowUrl(
        `/storylines/${encodeURIComponent(storylineId)}`,
        query,
      ),
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
        message: defaultRestoreErrorMessage,
      };
    }

    const result = GetStorylineResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultRestoreErrorMessage,
      };
    }

    return {
      status: "success",
      storyline: result.data.storyline,
    };
  } catch {
    return {
      status: "failed",
      message: defaultRestoreErrorMessage,
    };
  }
}

function buildStorylineWindowUrl(
  path: string,
  query: StorylineWindowQuery,
): string {
  const searchParams = new URLSearchParams({
    anchorPage: String(query.anchorPage),
    before: String(query.before),
    after: String(query.after),
  });
  return `${API_BASE_URL}${path}?${searchParams.toString()}`;
}

export type GetStorylineContextResult =
  | Readonly<{
      status: "success";
      context: StoryContextSnapshot | null;
      extraction: StoryContextExtractionState;
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStorylineContext(
  storylineId: StorylineId,
): Promise<GetStorylineContextResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/context`,
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
        message: defaultContextErrorMessage,
      };
    }

    const result = GetStorylineContextResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultContextErrorMessage,
      };
    }

    return {
      status: "success",
      context: result.data.context,
      extraction: result.data.extraction,
    };
  } catch {
    return {
      status: "failed",
      message: defaultContextErrorMessage,
    };
  }
}

export type StoryContextExtractionTaskResult =
  | Readonly<{ status: "success"; task: StoryContextExtractionTask | null }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "busy"; message: string }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function startStoryContextExtraction(
  storylineId: StorylineId,
): Promise<StoryContextExtractionTaskResult> {
  return requestStoryContextExtractionTask(
    "POST",
    `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/context/extraction`,
  );
}

export async function getStoryContextExtractionStatus(
  storylineId: StorylineId,
): Promise<StoryContextExtractionTaskResult> {
  return requestStoryContextExtractionTask(
    "GET",
    `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/context/extraction/status`,
  );
}

async function requestStoryContextExtractionTask(
  method: "GET" | "POST",
  url: string,
): Promise<StoryContextExtractionTaskResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authSession.session.accessToken}`,
      },
      method,
    });
    if (response.status === 401) {
      clearAuthSession();
      return { status: "authRequired" };
    }
    if (response.status === 404) {
      return { status: "notFound", message: defaultNotFoundErrorMessage };
    }
    if (response.status === 409) {
      return {
        status: "busy",
        message: "当前故事正在处理中，请稍后重试",
      };
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      return {
        status: "failed",
        message: defaultContextExtractionErrorMessage,
      };
    }
    const result =
      StoryContextExtractionTaskResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultContextExtractionErrorMessage,
      };
    }

    return { status: "success", task: result.data.task };
  } catch {
    return {
      status: "failed",
      message: defaultContextExtractionErrorMessage,
    };
  }
}

export type GetStoryGenerationStatusResult =
  | Readonly<{
      status: "success";
      task: StoryGenerationStatusResponse["task"];
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStoryGenerationStatus(
  storylineId: StorylineId,
): Promise<GetStoryGenerationStatusResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/generation/status`,
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
        message: defaultGenerationStatusErrorMessage,
      };
    }

    const result = StoryGenerationStatusResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultGenerationStatusErrorMessage,
      };
    }

    return {
      status: "success",
      task: result.data.task,
    };
  } catch {
    return {
      status: "failed",
      message: defaultGenerationStatusErrorMessage,
    };
  }
}

export type CancelStoryGenerationResult =
  | Readonly<{
      status: "success";
      cancelled: boolean;
      task: CancelStoryGenerationResponse["task"];
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function cancelStoryGeneration(
  storylineId: StorylineId,
): Promise<CancelStoryGenerationResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/generation/cancel`,
      {
        headers: {
          Authorization: `Bearer ${authSession.session.accessToken}`,
        },
        method: "POST",
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
        message: defaultGenerationCancelErrorMessage,
      };
    }

    const result = CancelStoryGenerationResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultGenerationCancelErrorMessage,
      };
    }

    return {
      status: "success",
      cancelled: result.data.cancelled,
      task: result.data.task,
    };
  } catch {
    return {
      status: "failed",
      message: defaultGenerationCancelErrorMessage,
    };
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}
