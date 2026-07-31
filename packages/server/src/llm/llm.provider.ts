import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextStreamUsage,
} from "@kimiko/schema";

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

export type LlmTextStreamEvent =
  | Readonly<{ type: "chunk"; delta: string }>
  | Readonly<{
      type: "completed";
      model: string;
      finishReason?: string;
      usage: GenerateLlmTextStreamUsage;
    }>;

export interface LlmStreamTelemetry {
  onFirstContent: (deltaChars: number) => void;
  onFirstReasoningContent: (deltaChars: number) => void;
  onFirstUpstreamSse: () => void;
}

export type LlmStreamOptions = Readonly<{
  signal: AbortSignal;
  telemetry?: LlmStreamTelemetry;
}>;

export interface LlmProvider {
  generateText(
    input: GenerateLlmTextRequest,
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<GenerateLlmTextResponse>;

  streamText(
    input: GenerateLlmTextRequest,
    options: LlmStreamOptions,
  ): AsyncIterable<LlmTextStreamEvent>;
}
