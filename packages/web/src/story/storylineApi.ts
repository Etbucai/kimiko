import type { StorylineSnapshot } from "@kimiko/schema";
import { GetRecentStorylineResponseSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const defaultRestoreErrorMessage = "恢复故事线失败，请稍后重试";

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
