import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError as OpenAiInternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextUsage,
} from "@kimiko/schema";
import type { LlmProvider } from "./llm.provider";

export type OpenAiCompatibleProviderConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}>;

export interface OpenAiClientLike {
  chat: {
    completions: {
      create(body: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
    };
  };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly client: OpenAiClientLike;

  constructor(
    private readonly config: OpenAiCompatibleProviderConfig,
    client?: OpenAiClientLike,
  ) {
    this.client = client ?? createOpenAiClient(config);
  }

  async generateText(
    input: GenerateLlmTextRequest,
  ): Promise<GenerateLlmTextResponse> {
    const completion = await this.createChatCompletion(input);
    return mapCompletionToGenerateTextResponse(completion);
  }

  private async createChatCompletion(
    input: GenerateLlmTextRequest,
  ): Promise<ChatCompletion> {
    try {
      return await this.client.chat.completions.create({
        model: this.config.model,
        messages: buildChatCompletionMessages(input),
      });
    } catch (error: unknown) {
      throw mapOpenAiError(error);
    }
  }
}

function createOpenAiClient(
  config: OpenAiCompatibleProviderConfig,
): OpenAiClientLike {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
}

function buildChatCompletionMessages(
  input: GenerateLlmTextRequest,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  if (input.systemPrompt !== undefined) {
    messages.push({
      role: "system",
      content: input.systemPrompt,
    });
  }

  messages.push({
    role: "user",
    content: input.userPrompt,
  });

  return messages;
}

function mapCompletionToGenerateTextResponse(
  completion: ChatCompletion,
): GenerateLlmTextResponse {
  const firstChoice = completion.choices[0];
  if (firstChoice === undefined) {
    throw new BadGatewayException(
      "LLM provider returned no completion choices",
    );
  }

  const text = firstChoice.message.content?.trim() ?? "";
  if (text.length === 0) {
    throw new BadGatewayException("LLM provider returned an empty response");
  }

  const usage = mapUsage(completion.usage);
  const finishReason = firstChoice.finish_reason ?? undefined;

  return {
    text,
    model: completion.model,
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

function mapUsage(
  usage: ChatCompletion["usage"] | undefined,
): GenerateLlmTextUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function mapOpenAiError(error: unknown): Error {
  if (error instanceof APIConnectionTimeoutError) {
    return new GatewayTimeoutException("LLM request timed out");
  }

  if (
    error instanceof APIConnectionError ||
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof RateLimitError ||
    error instanceof OpenAiInternalServerError
  ) {
    return new ServiceUnavailableException("LLM provider is unavailable");
  }

  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError ||
    error instanceof NotFoundError
  ) {
    return new BadGatewayException("LLM provider rejected the request");
  }

  if (error instanceof APIError) {
    return new ServiceUnavailableException("LLM provider request failed");
  }

  return new ServiceUnavailableException("LLM provider request failed");
}
