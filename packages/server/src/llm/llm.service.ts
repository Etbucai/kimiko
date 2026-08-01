import {
  BadGatewayException,
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
  buildLlmCallRequestMeta,
  createLlmCallId,
  type LlmCallFileError,
  type LlmCallFileRecord,
  type LlmCallFileUsage,
  type LlmCallType,
  writeLlmCallFile,
} from "./llm-call-file-logger";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamTelemetry,
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

export type LlmCallRecordingPolicy = "full" | "metrics-only";

export interface LlmStreamExecutionOptions {
  readonly signal: AbortSignal;
  readonly recordingPolicy?: LlmCallRecordingPolicy;
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

  streamText(
    body: unknown,
    options: LlmStreamExecutionOptions,
  ): AsyncIterable<LlmTextStreamEvent> {
    const request = parseRequest<GenerateLlmTextRequest>(
      GenerateLlmTextRequestSchema.safeParse(body),
    );

    return this.streamTextFromParsedRequest(request, options);
  }

  async generateTextFromParsedRequest(
    request: GenerateLlmTextRequest,
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<GenerateLlmTextResponse> {
    const callId = createLlmCallId();
    const startedAt = performance.now();
    const startedAtIso = new Date().toISOString();
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);
    const providerRequest: GenerateLlmTextRequest = {
      userPrompt: request.userPrompt.trim(),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
    this.logLlmCallStarted({
      callId,
      callType: "text",
      request: providerRequest,
    });

    try {
      const response = await this.llmProvider.generateText(
        providerRequest,
        options,
      );
      const completedAtIso = new Date().toISOString();
      const elapsedMs = getElapsedMs(startedAt);
      const usage = normalizeLoggedUsage(response.usage);
      await this.writeLlmCallFile(
        buildCompletedCallFileRecord({
          callId,
          callType: "text",
          completedAtIso,
          elapsedMs,
          finishReason: response.finishReason,
          model: response.model,
          outputText: response.text,
          request: providerRequest,
          startedAtIso,
          usage,
        }),
      );
      this.logLlmCallCompleted({
        callId,
        callType: "text",
        elapsedMs,
        finishReason: response.finishReason,
        model: response.model,
        usage,
      });
      return response;
    } catch (error: unknown) {
      const completedAtIso = new Date().toISOString();
      const elapsedMs = getElapsedMs(startedAt);
      await this.writeLlmCallFile(
        buildFailedCallFileRecord({
          callId,
          callType: "text",
          completedAtIso,
          elapsedMs,
          error,
          outputText: "",
          request: providerRequest,
          startedAtIso,
        }),
      );
      this.logLlmCallFailed({
        callId,
        callType: "text",
        elapsedMs,
        error,
      });
      throw error;
    }
  }

  async *streamTextFromParsedRequest(
    request: GenerateLlmTextRequest,
    options: LlmStreamExecutionOptions,
  ): AsyncIterable<LlmTextStreamEvent> {
    const callId = createLlmCallId();
    const startedAt = performance.now();
    const startedAtIso = new Date().toISOString();
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);
    const providerRequest: GenerateLlmTextRequest = {
      userPrompt: request.userPrompt.trim(),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
    const recordingPolicy = options.recordingPolicy ?? "full";
    let outputText = recordingPolicy === "full" ? "" : null;
    let outputTextChars = 0;
    let completed = false;
    let hasReceivedFirstEvent = false;
    let hasReceivedFirstChunk = false;

    this.logLlmCallStarted({
      callId,
      callType: "stream",
      request: providerRequest,
    });
    const telemetry: LlmStreamTelemetry = {
      onFirstContent: (deltaChars) => {
        this.logLlmStreamMilestone({
          callId,
          deltaChars,
          elapsedMs: getElapsedMs(startedAt),
          event: "llm_stream_first_content",
        });
      },
      onFirstReasoningContent: (deltaChars) => {
        this.logLlmStreamMilestone({
          callId,
          deltaChars,
          elapsedMs: getElapsedMs(startedAt),
          event: "llm_stream_first_reasoning_content",
        });
      },
      onFirstUpstreamSse: () => {
        this.logLlmStreamMilestone({
          callId,
          elapsedMs: getElapsedMs(startedAt),
          event: "llm_stream_first_upstream_sse",
        });
      },
    };

    try {
      for await (const event of this.llmProvider.streamText(providerRequest, {
        signal: options.signal,
        telemetry,
      })) {
        if (!hasReceivedFirstEvent) {
          hasReceivedFirstEvent = true;
          this.logLlmStreamFirstEvent({
            callId,
            elapsedMs: getElapsedMs(startedAt),
            eventType: event.type,
          });
        }

        if (event.type === "completed") {
          completed = true;
          const completedAtIso = new Date().toISOString();
          const elapsedMs = getElapsedMs(startedAt);
          const usage = normalizeLoggedUsage(event.usage);
          if (outputText !== null) {
            await this.writeLlmCallFile(
              buildCompletedCallFileRecord({
                callId,
                callType: "stream",
                completedAtIso,
                elapsedMs,
                finishReason: event.finishReason,
                model: event.model,
                outputText,
                request: providerRequest,
                startedAtIso,
                usage,
              }),
            );
          }
          this.logLlmCallCompleted({
            callId,
            callType: "stream",
            elapsedMs,
            finishReason: event.finishReason,
            model: event.model,
            usage,
          });
          yield event;
          continue;
        }

        if (event.type === "reasoning") {
          yield event;
          continue;
        }

        if (!hasReceivedFirstChunk) {
          hasReceivedFirstChunk = true;
          this.logLlmStreamFirstChunk({
            callId,
            deltaChars: event.delta.length,
            elapsedMs: getElapsedMs(startedAt),
          });
        }
        outputTextChars += event.delta.length;
        if (outputText !== null) {
          outputText += event.delta;
        }
        yield event;
      }

      if (!completed) {
        if (options.signal.aborted) {
          this.logLlmCallAborted({
            callId,
            callType: "stream",
            elapsedMs: getElapsedMs(startedAt),
            outputTextChars,
          });
          return;
        }

        throw new BadGatewayException("LLM stream ended without completion");
      }
    } catch (error: unknown) {
      const elapsedMs = getElapsedMs(startedAt);
      if (options.signal.aborted) {
        this.logLlmCallAborted({
          callId,
          callType: "stream",
          elapsedMs,
          outputTextChars,
        });
        throw error;
      }

      const completedAtIso = new Date().toISOString();
      if (outputText !== null) {
        await this.writeLlmCallFile(
          buildFailedCallFileRecord({
            callId,
            callType: "stream",
            completedAtIso,
            elapsedMs,
            error,
            outputText,
            request: providerRequest,
            startedAtIso,
          }),
        );
      }
      this.logLlmCallFailed({
        callId,
        callType: "stream",
        elapsedMs,
        error,
        includeErrorDetails: recordingPolicy === "full",
      });
      throw error;
    }
  }

  private logLlmCallAborted(
    input: Readonly<{
      callId: string;
      callType: LlmCallType;
      elapsedMs: number;
      outputTextChars: number;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        callType: input.callType,
        elapsedMs: input.elapsedMs,
        event: "llm_call_aborted",
        outputTextChars: input.outputTextChars,
        usage: normalizeLoggedUsage(undefined),
      }),
    );
  }

  private logLlmCallStarted(
    input: Readonly<{
      callId: string;
      callType: LlmCallType;
      request: GenerateLlmTextRequest;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        callType: input.callType,
        event: "llm_call_started",
        requestMeta: buildLlmCallRequestMeta(input.request),
      }),
    );
  }

  private logLlmCallCompleted(
    input: Readonly<{
      callId: string;
      callType: LlmCallType;
      elapsedMs: number;
      finishReason: string | undefined;
      model: string;
      usage: LlmCallFileUsage;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        callType: input.callType,
        elapsedMs: input.elapsedMs,
        event: "llm_call_completed",
        finishReason: input.finishReason,
        model: input.model,
        usage: input.usage,
      }),
    );
  }

  private logLlmStreamFirstEvent(
    input: Readonly<{
      callId: string;
      elapsedMs: number;
      eventType: LlmTextStreamEvent["type"];
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        elapsedMs: input.elapsedMs,
        event: "llm_stream_first_event",
        eventType: input.eventType,
      }),
    );
  }

  private logLlmStreamFirstChunk(
    input: Readonly<{
      callId: string;
      deltaChars: number;
      elapsedMs: number;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        deltaChars: input.deltaChars,
        elapsedMs: input.elapsedMs,
        event: "llm_stream_first_chunk",
      }),
    );
  }

  private logLlmStreamMilestone(
    input: Readonly<{
      callId: string;
      deltaChars?: number;
      elapsedMs: number;
      event:
        | "llm_stream_first_content"
        | "llm_stream_first_reasoning_content"
        | "llm_stream_first_upstream_sse";
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        callId: input.callId,
        ...(input.deltaChars !== undefined
          ? { deltaChars: input.deltaChars }
          : {}),
        elapsedMs: input.elapsedMs,
        event: input.event,
      }),
    );
  }

  private logLlmCallFailed(
    input: Readonly<{
      callId: string;
      callType: LlmCallType;
      elapsedMs: number;
      error: unknown;
      includeErrorDetails?: boolean;
    }>,
  ): void {
    this.logger.error(
      JSON.stringify({
        callId: input.callId,
        callType: input.callType,
        elapsedMs: input.elapsedMs,
        error:
          input.includeErrorDetails === false
            ? { name: getErrorName(input.error) }
            : toLoggableError(input.error),
        event: "llm_call_failed",
        usage: normalizeLoggedUsage(undefined),
      }),
    );
  }

  private async writeLlmCallFile(record: LlmCallFileRecord): Promise<void> {
    try {
      await writeLlmCallFile(record);
    } catch (error: unknown) {
      this.logger.error(
        JSON.stringify({
          callId: record.callId,
          callType: record.callType,
          error: toLoggableError(error),
          event: "llm_call_file_write_failed",
        }),
      );
    }
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
): LlmCallFileUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
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

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function toLlmCallFileError(error: unknown): LlmCallFileError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack ?? null,
    };
  }

  return {
    message: String(error),
    name: "UnknownError",
    stack: null,
  };
}

function buildCompletedCallFileRecord(
  input: Readonly<{
    callId: string;
    callType: LlmCallType;
    completedAtIso: string;
    elapsedMs: number;
    finishReason: string | undefined;
    model: string;
    outputText: string;
    request: GenerateLlmTextRequest;
    startedAtIso: string;
    usage: LlmCallFileUsage;
  }>,
): LlmCallFileRecord {
  return {
    callId: input.callId,
    callType: input.callType,
    completedAt: input.completedAtIso,
    elapsedMs: input.elapsedMs,
    error: null,
    request: input.request,
    requestMeta: buildLlmCallRequestMeta(input.request),
    response: {
      finishReason: input.finishReason ?? null,
      model: input.model,
      text: input.outputText,
      textChars: input.outputText.length,
      usage: input.usage,
    },
    schemaVersion: 1,
    startedAt: input.startedAtIso,
    status: "completed",
  };
}

function buildFailedCallFileRecord(
  input: Readonly<{
    callId: string;
    callType: LlmCallType;
    completedAtIso: string;
    elapsedMs: number;
    error: unknown;
    outputText: string;
    request: GenerateLlmTextRequest;
    startedAtIso: string;
  }>,
): LlmCallFileRecord {
  return {
    callId: input.callId,
    callType: input.callType,
    completedAt: input.completedAtIso,
    elapsedMs: input.elapsedMs,
    error: toLlmCallFileError(input.error),
    request: input.request,
    requestMeta: buildLlmCallRequestMeta(input.request),
    response:
      input.outputText.length > 0
        ? {
            finishReason: null,
            model: null,
            text: input.outputText,
            textChars: input.outputText.length,
            usage: normalizeLoggedUsage(undefined),
          }
        : null,
    schemaVersion: 1,
    startedAt: input.startedAtIso,
    status: "failed",
  };
}
