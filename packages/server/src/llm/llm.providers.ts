import { ServiceUnavailableException } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { Env } from "../env";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmTextStreamEvent,
} from "./llm.provider";
import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider";

class UnspecifiedProvider implements LlmProvider {
  async generateText(
    _input: GenerateLlmTextRequest,
    _options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<never> {
    throw new ServiceUnavailableException(
      "LLM provider is not configured. Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.",
    );
  }

  streamText(
    _input: GenerateLlmTextRequest,
    _options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<LlmTextStreamEvent> {
    return createUnavailableStream();
  }
}

function createUnavailableStream(): AsyncIterable<LlmTextStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmTextStreamEvent> {
      return {
        async next(): Promise<IteratorResult<LlmTextStreamEvent>> {
          throw new ServiceUnavailableException(
            "LLM provider is not configured. Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.",
          );
        },
      };
    },
  };
}

function createLlmProvider(): LlmProvider {
  const llmConfig = Env.llm;
  if (llmConfig === null) {
    return new UnspecifiedProvider();
  }

  return new OpenAiCompatibleProvider({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    timeoutMs: llmConfig.timeoutMs,
  });
}

export const llmProviders: Provider[] = [
  {
    provide: LLM_PROVIDER,
    useFactory: (): LlmProvider => createLlmProvider(),
  },
];
