import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextUsage,
} from "@kimiko/schema";

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

export type LlmTextStreamEvent =
  | Readonly<{ type: "chunk"; delta: string }>
  | Readonly<{
      type: "completed";
      model: string;
      usage: Required<GenerateLlmTextUsage>;
    }>;

export interface LlmProvider {
  generateText(
    input: GenerateLlmTextRequest,
  ): Promise<GenerateLlmTextResponse>;

  streamText(
    input: GenerateLlmTextRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<LlmTextStreamEvent>;
}
