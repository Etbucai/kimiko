import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config } from "dotenv";

type EnvShape = Readonly<{
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  llm: LlmEnvShape | null;
  story: StoryEnvShape;
}>;

type LlmEnvShape = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}>;

type StoryEnvShape = Readonly<{
  historyAppendScore: number;
  historyDialogueScore: number;
  historyScoreLimit: number;
}>;

const serverRoot = resolve(__dirname, "..");
const DEFAULT_LOCAL_JWT_SECRET = "kimiko-local-development-jwt-secret";

loadDotenvFiles();

let currentEnv = buildEnv(process.env);

export const Env = {
  get port(): number {
    return currentEnv.port;
  },
  get databaseUrl(): string {
    return currentEnv.databaseUrl;
  },
  get jwtSecret(): string {
    return currentEnv.jwtSecret;
  },
  get llm(): LlmEnvShape | null {
    if (currentEnv.llm === null) {
      return null;
    }

    return { ...currentEnv.llm };
  },
  get story(): StoryEnvShape {
    return { ...currentEnv.story };
  },
} as const;

export function reloadEnvForTesting(): void {
  loadDotenvFiles();
  currentEnv = buildEnv(process.env);
}

export function resolveServerPath(path: string): string {
  return isAbsolute(path) ? path : resolve(serverRoot, path);
}

export function ensureServerDirectoryForPath(path: string): void {
  if (path === ":memory:") {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
}

function loadDotenvFiles(): void {
  config({ path: resolve(serverRoot, ".env") });
  config({ path: resolve(serverRoot, ".env.local"), override: true });
}

function buildEnv(source: NodeJS.ProcessEnv): EnvShape {
  return {
    port: parsePort(source.PORT),
    databaseUrl: parseDatabaseUrl(source.DATABASE_URL, source.NODE_ENV),
    jwtSecret: parseJwtSecret(source.JWT_SECRET, source.NODE_ENV),
    llm: parseLlmEnv(source),
    story: parseStoryEnv(source),
  };
}

function parseStoryEnv(source: NodeJS.ProcessEnv): StoryEnvShape {
  return {
    historyAppendScore:
      parseOptionalPositiveInteger(
        source.STORY_HISTORY_APPEND_SCORE,
        "STORY_HISTORY_APPEND_SCORE",
      ) ?? 5,
    historyDialogueScore:
      parseOptionalPositiveInteger(
        source.STORY_HISTORY_DIALOGUE_SCORE,
        "STORY_HISTORY_DIALOGUE_SCORE",
      ) ?? 1,
    historyScoreLimit:
      parseOptionalPositiveInteger(
        source.STORY_HISTORY_SCORE_LIMIT,
        "STORY_HISTORY_SCORE_LIMIT",
      ) ?? 100,
  };
}

function parseLlmEnv(source: NodeJS.ProcessEnv): LlmEnvShape | null {
  const baseUrl = parseOptionalUrl(source.LLM_BASE_URL, "LLM_BASE_URL");
  const apiKey = parseOptionalNonEmptyString(source.LLM_API_KEY);
  const model = parseOptionalNonEmptyString(source.LLM_MODEL);
  const timeoutMs =
    parseOptionalPositiveInteger(source.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS") ??
    30_000;

  const hasAnyLlmProviderConfig =
    baseUrl !== undefined || apiKey !== undefined || model !== undefined;

  if (!hasAnyLlmProviderConfig) {
    return null;
  }

  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error(
      "LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must all be set together",
    );
  }

  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs,
  };
}

function parseJwtSecret(
  value: string | undefined,
  nodeEnv: string | undefined,
): string {
  const normalizedValue = parseOptionalNonEmptyString(value);
  if (normalizedValue !== undefined) {
    return normalizedValue;
  }

  if (nodeEnv === "production") {
    throw new Error("JWT_SECRET is required in production");
  }

  return DEFAULT_LOCAL_JWT_SECRET;
}

function parseDatabaseUrl(
  value: string | undefined,
  nodeEnv: string | undefined,
): string {
  const normalizedValue = parseOptionalNonEmptyString(value);
  if (normalizedValue !== undefined) {
    return normalizedValue;
  }

  return nodeEnv === "test" ? ":memory:" : "data/kimiko.sqlite";
}

function parsePort(value: string | undefined): number {
  const normalizedValue = parseOptionalNonEmptyString(value);
  if (normalizedValue === undefined) {
    return 3000;
  }

  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error("PORT must be an integer");
  }

  const port = Number(normalizedValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }

  return port;
}

function parseOptionalUrl(
  value: string | undefined,
  key: "LLM_BASE_URL",
): string | undefined {
  const normalizedValue = parseOptionalNonEmptyString(value);
  if (normalizedValue === undefined) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(normalizedValue);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }

  return url.toString().replace(/\/$/, "");
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  key:
    | "LLM_TIMEOUT_MS"
    | "STORY_HISTORY_APPEND_SCORE"
    | "STORY_HISTORY_DIALOGUE_SCORE"
    | "STORY_HISTORY_SCORE_LIMIT",
): number | undefined {
  const normalizedValue = parseOptionalNonEmptyString(value);
  if (normalizedValue === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`${key} must be a positive integer`);
  }

  const parsedValue = Number(normalizedValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsedValue;
}

function parseOptionalNonEmptyString(
  value: string | undefined,
): string | undefined {
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  return normalizedValue.length > 0 ? normalizedValue : undefined;
}
