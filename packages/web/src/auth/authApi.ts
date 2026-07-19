import type {
  GetMyUserInfoResponse,
  LoginSession,
  LoginUserRequest,
  RegisterUserRequest,
  RegisterUserResponse,
} from "@kimiko/schema";
import {
  GetMyUserInfoResponseSchema,
  LoginSessionSchema,
  LoginUserResponseSchema,
  RegisterUserResponseSchema,
} from "@kimiko/schema";

const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
const AUTH_SESSION_STORAGE_KEY = "kimiko.auth.session";

export interface PersistedAuthSession {
  session: LoginSession;
  me: GetMyUserInfoResponse;
}

interface AccessTokenPayload {
  sub: string;
  uniqueName: string;
  exp: number;
}

export async function loginUser(
  request: LoginUserRequest,
): Promise<PersistedAuthSession> {
  const loginResult = await postJson("/user/login", request, (value) =>
    LoginUserResponseSchema.parse(value),
  );

  return {
    session: loginResult.session,
    me: loginResult.me,
  };
}

export async function registerUser(
  request: RegisterUserRequest,
): Promise<RegisterUserResponse> {
  return postJson("/user/register", request, (value) =>
    RegisterUserResponseSchema.parse(value),
  );
}

export function saveAuthSession(authSession: PersistedAuthSession): void {
  localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(authSession));
}

export function getStoredAuthSession(): PersistedAuthSession | null {
  const rawSession = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (rawSession === null) {
    return null;
  }

  try {
    const parsedSession = parsePersistedAuthSession(JSON.parse(rawSession));
    if (parsedSession === null || !isAuthSessionCurrent(parsedSession)) {
      clearAuthSession();
      return null;
    }

    return parsedSession;
  } catch {
    clearAuthSession();
    return null;
  }
}

export function clearAuthSession(): void {
  localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "请求失败，请稍后重试";
}

async function postJson<TRequest, TResponse>(
  path: string,
  body: TRequest,
  parseResponse: (value: unknown) => TResponse,
): Promise<TResponse> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getResponseErrorMessage(responseBody, response.status));
  }

  return parseResponse(responseBody);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }

  return JSON.parse(text) as unknown;
}

function getResponseErrorMessage(responseBody: unknown, status: number): string {
  if (isRecord(responseBody)) {
    const message = responseBody.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }

    if (Array.isArray(message) && message.every(isNonEmptyString)) {
      return message.join("；");
    }
  }

  return `请求失败 (${status})`;
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parsePersistedAuthSession(value: unknown): PersistedAuthSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const session = LoginSessionSchema.safeParse(value.session);
  const me = GetMyUserInfoResponseSchema.safeParse(value.me);
  if (!session.success || !me.success || session.data.userId !== me.data.userId) {
    return null;
  }

  return {
    session: session.data,
    me: me.data,
  };
}

function isAuthSessionCurrent(authSession: PersistedAuthSession): boolean {
  const payload = parseAccessTokenPayload(authSession.session.accessToken);
  if (payload === null) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  return (
    payload.exp > nowInSeconds &&
    payload.sub === authSession.session.userId &&
    payload.uniqueName === authSession.me.uniqueName
  );
}

function parseAccessTokenPayload(token: string): AccessTokenPayload | null {
  const tokenParts = token.split(".");
  const payloadPart = tokenParts[1];
  if (tokenParts.length !== 3 || payloadPart === undefined) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart)) as unknown;
    if (!isAccessTokenPayload(payload)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalizedValue = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalizedValue.length % 4)) % 4;
  return atob(`${normalizedValue}${"=".repeat(paddingLength)}`);
}

function isAccessTokenPayload(value: unknown): value is AccessTokenPayload {
  return (
    isRecord(value) &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    typeof value.uniqueName === "string" &&
    value.uniqueName.length > 0 &&
    typeof value.exp === "number" &&
    Number.isFinite(value.exp)
  );
}
