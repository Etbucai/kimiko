import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextUsage,
} from "@kimiko/schema";
import { GenerateLlmTextRequestSchema } from "@kimiko/schema";
import { performance } from "node:perf_hooks";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmTextStreamEvent,
} from "./llm.provider";

type SchemaParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{
      success: false;
      error: {
        issues: readonly {
          path: readonly PropertyKey[];
          message: string;
        }[];
      };
    }>;

type LlmCallType = "stream" | "text";

interface LoggedLlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
  ) {}

  async generateText(body: unknown): Promise<GenerateLlmTextResponse> {
    const request = parseRequest<GenerateLlmTextRequest>(
      GenerateLlmTextRequestSchema.safeParse(body),
    );

    return this.generateTextFromParsedRequest(request);
  }

  async generateTextFromParsedRequest(
    request: GenerateLlmTextRequest,
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<GenerateLlmTextResponse> {
    const startedAt = performance.now();
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);

    try {
      const response = await this.llmProvider.generateText(
        {
          userPrompt: request.userPrompt.trim(),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        },
        options,
      );
      this.logLlmCallCompleted({
        callType: "text",
        finishReason: response.finishReason,
        model: response.model,
        startedAt,
        usage: response.usage,
      });
      return response;
    } catch (error: unknown) {
      this.logLlmCallFailed({
        callType: "text",
        error,
        startedAt,
      });
      throw error;
    }
  }

  async *streamTextFromParsedRequest(
    request: GenerateLlmTextRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<LlmTextStreamEvent> {
    const startedAt = performance.now();
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);

    try {
      for await (const event of this.llmProvider.streamText(
        {
          userPrompt: request.userPrompt.trim(),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        },
        options,
      )) {
        if (event.type === "completed") {
          yield event;
          this.logLlmCallCompleted({
            callType: "stream",
            finishReason: undefined,
            model: event.model,
            startedAt,
            usage: event.usage,
          });
          continue;
        }

        yield event;
      }
    } catch (error: unknown) {
      this.logLlmCallFailed({
        callType: "stream",
        error,
        startedAt,
      });
      throw error;
    }
  }

  private logLlmCallCompleted(
    input: Readonly<{
      callType: LlmCallType;
      finishReason: string | undefined;
      model: string;
      startedAt: number;
      usage: GenerateLlmTextUsage | undefined;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callType: input.callType,
        elapsedMs: getElapsedMs(input.startedAt),
        event: "llm_call_completed",
        finishReason: input.finishReason,
        model: input.model,
        usage: normalizeLoggedUsage(input.usage),
      }),
    );
  }

  private logLlmCallFailed(
    input: Readonly<{
      callType: LlmCallType;
      error: unknown;
      startedAt: number;
    }>,
  ): void {
    this.logger.error(
      JSON.stringify({
        callType: input.callType,
        elapsedMs: getElapsedMs(input.startedAt),
        error: toLoggableError(input.error),
        event: "llm_call_failed",
        usage: normalizeLoggedUsage(undefined),
      }),
    );
  }
}

function normalizeOptionalPrompt(
  value: string | undefined,
): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue !== undefined && normalizedValue.length > 0
    ? normalizedValue
    : undefined;
}

function parseRequest<T>(result: SchemaParseResult<T>): T {
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  if (firstIssue === undefined) {
    throw new BadRequestException("Request body is invalid");
  }

  const fieldPath = firstIssue.path.map(String).join(".");
  const prefix = fieldPath.length > 0 ? `${fieldPath}: ` : "";
  throw new BadRequestException(`${prefix}${firstIssue.message}`);
}

function getElapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function normalizeLoggedUsage(
  usage: GenerateLlmTextUsage | undefined,
): LoggedLlmUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
}

function toLoggableError(error: unknown): Readonly<{
  message: string;
  name: string;
}> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: String(error),
    name: "UnknownError",
  };
}
