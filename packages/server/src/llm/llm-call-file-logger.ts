import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type LlmCallType = "stream" | "text";

export interface LlmCallFileUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface LlmCallFileResponse {
  readonly finishReason: string | null;
  readonly model: string | null;
  readonly text: string;
  readonly textChars: number;
  readonly usage: LlmCallFileUsage;
}

export interface LlmCallFileError {
  readonly message: string;
  readonly name: string;
  readonly stack: string | null;
}

export interface LlmCallFileRecord {
  readonly callId: string;
  readonly callType: LlmCallType;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly error: LlmCallFileError | null;
  readonly request: GenerateLlmTextRequest;
  readonly requestMeta: {
    readonly systemPromptChars: number | null;
    readonly userPromptChars: number;
  };
  readonly response: LlmCallFileResponse | null;
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly status: "completed" | "failed";
}

export function createLlmCallId(): string {
  return randomUUID();
}

export async function writeLlmCallFile(
  record: LlmCallFileRecord,
): Promise<string | null> {
  const directory = resolveLlmCallLogDirectory();
  if (directory === null) {
    return null;
  }

  await mkdir(directory, { recursive: true });
  const filePath = join(directory, buildLlmCallFileName(record));
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export function buildLlmCallRequestMeta(
  request: GenerateLlmTextRequest,
): LlmCallFileRecord["requestMeta"] {
  return {
    systemPromptChars: request.systemPrompt?.length ?? null,
    userPromptChars: request.userPrompt.length,
  };
}

function resolveLlmCallLogDirectory(): string | null {
  const configuredDirectory = process.env.KIMIKO_LLM_CALL_LOG_DIR?.trim();
  if (configuredDirectory !== undefined && configuredDirectory.length > 0) {
    return isAbsolute(configuredDirectory)
      ? configuredDirectory
      : resolve(findProjectRoot(process.cwd()), configuredDirectory);
  }

  return join(findProjectRoot(process.cwd()), "log");
}

function buildLlmCallFileName(record: LlmCallFileRecord): string {
  return (
    [
      sanitizeFileNameTimestamp(record.startedAt),
      record.callType,
      record.status,
      record.callId,
    ].join("-") + ".json"
  );
}

function sanitizeFileNameTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function findProjectRoot(startDirectory: string): string {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    if (isKimikoRoot(currentDirectory)) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return resolve(startDirectory);
    }

    currentDirectory = parentDirectory;
  }
}

function isKimikoRoot(directory: string): boolean {
  const packageJsonPath = join(directory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as unknown;
    return (
      typeof packageJson === "object" &&
      packageJson !== null &&
      "name" in packageJson &&
      packageJson.name === "kimiko"
    );
  } catch {
    return false;
  }
}
