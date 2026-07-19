import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

export interface LlmProvider {
  generateText(
    input: GenerateLlmTextRequest,
  ): Promise<GenerateLlmTextResponse>;
}
