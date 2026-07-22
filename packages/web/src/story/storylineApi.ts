import type {
  StorylineListItem,
  StoryCharacterSummarySnapshot,
  StorylineId,
  StorylineSnapshot,
} from "@kimiko/schema";
import {
  GetStorylineResponseSchema,
  GetRecentStorylineResponseSchema,
  GetStorylineSummaryResponseSchema,
  ListStorylinesResponseSchema,
} from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultListErrorMessage = "加载故事列表失败，请稍后重试";
const defaultRestoreErrorMessage = "恢复故事线失败，请稍后重试";
const defaultNotFoundErrorMessage = "故事线不存在或已不可用";
const defaultSummaryErrorMessage = "获取角色摘要失败，请稍后重试";

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

export async function getRecentStoryline(): Promise<GetRecentStorylineResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/storylines/recent`, {
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
): Promise<GetStorylineResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}`,
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

export type GetStorylineSummaryResult =
  | Readonly<{
      status: "success";
      summary: StoryCharacterSummarySnapshot | null;
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStorylineSummary(
  storylineId: StorylineId,
): Promise<GetStorylineSummaryResult> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    return { status: "authRequired" };
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/storylines/${encodeURIComponent(storylineId)}/summary`,
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
        message: defaultSummaryErrorMessage,
      };
    }

    const result = GetStorylineSummaryResponseSchema.safeParse(responseBody);
    if (!result.success) {
      return {
        status: "failed",
        message: defaultSummaryErrorMessage,
      };
    }

    return {
      status: "success",
      summary: result.data.summary,
    };
  } catch {
    return {
      status: "failed",
      message: defaultSummaryErrorMessage,
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
