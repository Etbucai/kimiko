import type {
  ContinueStoryRequest,
  ContinueStoryResponse,
} from "@kimiko/schema";
import { ContinueStoryResponseSchema } from "@kimiko/schema";
import { clearAuthSession, getStoredAuthSession } from "../auth/authApi";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export class StoryAuthRequiredError extends Error {
  constructor() {
    super("登录状态已失效");
    this.name = "StoryAuthRequiredError";
  }
}

export class StoryGenerationError extends Error {
  constructor() {
    super("生成失败，请稍后重试");
    this.name = "StoryGenerationError";
  }
}

export async function continueStory(
  request: ContinueStoryRequest,
): Promise<ContinueStoryResponse> {
  const authSession = getStoredAuthSession();
  if (authSession === null) {
    throw new StoryAuthRequiredError();
  }

  const response = await fetch(`${API_BASE_URL}/story/continue`, {
    body: JSON.stringify(request),
    headers: {
      Authorization: `Bearer ${authSession.session.accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (response.status === 401) {
    clearAuthSession();
    throw new StoryAuthRequiredError();
  }

  if (!response.ok) {
    throw new StoryGenerationError();
  }

  const responseBody = await readJsonResponse(response);
  return ContinueStoryResponseSchema.parse(responseBody);
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
