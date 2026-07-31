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
  ChatCompletionCreateParamsStreaming,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextStreamUsage,
  GenerateLlmTextUsage,
} from "@kimiko/schema";
import type {
  LlmProvider,
  LlmStreamOptions,
  LlmTextStreamEvent,
} from "./llm.provider";

export type OpenAiCompatibleProviderConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}>;

export interface OpenAiClientLike {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: Readonly<{ signal: AbortSignal }>,
      ): Promise<ChatCompletion>;
      create(
        body: ChatCompletionCreateParamsStreaming,
        options: Readonly<{ signal: AbortSignal }>,
      ): Promise<AsyncIterable<ChatCompletionChunk>>;
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
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<GenerateLlmTextResponse> {
    const completion = await this.createChatCompletion(input, options);
    return mapCompletionToGenerateTextResponse(completion);
  }

  async *streamText(
    input: GenerateLlmTextRequest,
    options: LlmStreamOptions,
  ): AsyncIterable<LlmTextStreamEvent> {
    const stream = await this.createChatCompletionStream(input, options);
    let model = "";
    let finishReason: string | undefined;
    let usage: GenerateLlmTextStreamUsage | undefined;
    let hasObservedContent = false;
    let hasObservedReasoningContent = false;
    let hasObservedUpstreamSse = false;

    for await (const chunk of stream) {
      if (!hasObservedUpstreamSse) {
        hasObservedUpstreamSse = true;
        options.telemetry?.onFirstUpstreamSse();
      }

      if (chunk.model.length > 0) {
        model = chunk.model;
      }

      const chunkFinishReason = chunk.choices[0]?.finish_reason;
      if (
        typeof chunkFinishReason === "string" &&
        chunkFinishReason.length > 0
      ) {
        finishReason = chunkFinishReason;
      }

      const reasoningContent = getReasoningContent(chunk);
      if (reasoningContent !== undefined) {
        if (!hasObservedReasoningContent) {
          hasObservedReasoningContent = true;
          options.telemetry?.onFirstReasoningContent(reasoningContent.length);
        }

        yield {
          type: "reasoning",
          delta: reasoningContent,
        };
      }

      const content = chunk.choices[0]?.delta.content;
      if (typeof content === "string" && content.length > 0) {
        if (!hasObservedContent) {
          hasObservedContent = true;
          options.telemetry?.onFirstContent(content.length);
        }

        yield {
          type: "chunk",
          delta: content,
        };
      }

      const mappedUsage = mapRequiredUsage(chunk.usage);
      if (mappedUsage !== undefined) {
        usage = mappedUsage;
      }
    }

    if (usage === undefined) {
      throw new BadGatewayException(
        "LLM provider returned incomplete token usage",
      );
    }

    if (model.length === 0) {
      throw new BadGatewayException("LLM provider returned an empty model");
    }

    yield {
      type: "completed",
      model,
      ...(finishReason !== undefined ? { finishReason } : {}),
      usage,
    };
  }

  private async createChatCompletion(
    input: GenerateLlmTextRequest,
    options?: Readonly<{ signal: AbortSignal }>,
  ): Promise<ChatCompletion> {
    try {
      const request = buildChatCompletionRequest(input, this.config);

      return options === undefined
        ? await this.client.chat.completions.create(request)
        : await this.client.chat.completions.create(request, options);
    } catch (error: unknown) {
      throw mapOpenAiError(error);
    }
  }

  private async createChatCompletionStream(
    input: GenerateLlmTextRequest,
    options: LlmStreamOptions,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    try {
      return await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: buildChatCompletionMessages(input),
          stream: true,
          stream_options: {
            include_usage: true,
          },
        },
        {
          signal: options.signal,
        },
      );
    } catch (error: unknown) {
      throw mapOpenAiError(error);
    }
  }
}

function buildChatCompletionRequest(
  input: GenerateLlmTextRequest,
  config: OpenAiCompatibleProviderConfig,
): ChatCompletionCreateParamsNonStreaming {
  const request: ChatCompletionCreateParamsNonStreaming = {
    model: config.model,
    messages: buildChatCompletionMessages(input),
  };

  if (shouldUseDeepSeekJsonMode(input, config)) {
    return {
      ...request,
      response_format: { type: "json_object" },
    };
  }

  return request;
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

function shouldUseDeepSeekJsonMode(
  input: GenerateLlmTextRequest,
  config: OpenAiCompatibleProviderConfig,
): boolean {
  if (!isDeepSeekBaseUrl(config.baseUrl)) {
    return false;
  }

  const promptText = `${input.systemPrompt ?? ""}\n${input.userPrompt}`;
  return /\bjson\b/i.test(promptText);
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.deepseek.com" &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
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

  const reasoningTokens = getReasoningTokens(usage);
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: usage.total_tokens,
  };
}

function mapRequiredUsage(
  usage: ChatCompletionChunk["usage"] | undefined | null,
): GenerateLlmTextStreamUsage | undefined {
  if (usage === undefined || usage === null) {
    return undefined;
  }

  const reasoningTokens = getReasoningTokens(usage);
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: usage.total_tokens,
  };
}

function getReasoningContent(chunk: ChatCompletionChunk): string | undefined {
  const delta = chunk.choices[0]?.delta as
    | (ChatCompletionChunk["choices"][number]["delta"] & {
        reasoning_content?: unknown;
      })
    | undefined;
  const reasoningContent = delta?.reasoning_content;
  return typeof reasoningContent === "string" && reasoningContent.length > 0
    ? reasoningContent
    : undefined;
}

function getReasoningTokens(
  usage: NonNullable<ChatCompletion["usage"]>,
): number | undefined {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return typeof reasoningTokens === "number" ? reasoningTokens : undefined;
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
