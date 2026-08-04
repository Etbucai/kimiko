import {
  BadGatewayException,
  GatewayTimeoutException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError,
  RateLimitError,
} from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import {
  OpenAiCompatibleProvider,
  type OpenAiClientLike,
} from "./openai-compatible.provider";

type ChatCompletionCreateMock = jest.Mock<
  Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>,
  [
    (
      | ChatCompletionCreateParamsNonStreaming
      | ChatCompletionCreateParamsStreaming
    ),
    Readonly<{ signal: AbortSignal }>?,
  ]
>;

interface MockOpenAiClient {
  chat: {
    completions: {
      create: ChatCompletionCreateMock;
    };
  };
}

describe("OpenAiCompatibleProvider", () => {
  let client: MockOpenAiClient;
  let loggerErrorSpy: jest.SpyInstance;
  let provider: OpenAiCompatibleProvider;

  beforeEach(() => {
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const createMock: ChatCompletionCreateMock = jest.fn<
      Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>,
      [
        (
          | ChatCompletionCreateParamsNonStreaming
          | ChatCompletionCreateParamsStreaming
        ),
        Readonly<{ signal: AbortSignal }>?,
      ]
    >();
    client = {
      chat: {
        completions: {
          create: createMock,
        },
      },
    };

    provider = new OpenAiCompatibleProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "default-model",
        timeoutMs: 30_000,
      },
      client as unknown as OpenAiClientLike,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the configured model and maps the response payload", async () => {
    client.chat.completions.create.mockResolvedValue({
      model: "default-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "  answer from model  ",
          },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        completion_tokens_details: {
          reasoning_tokens: 3,
        },
        total_tokens: 18,
      },
    } as ChatCompletion);

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).resolves.toEqual({
      text: "answer from model",
      model: "default-model",
      finishReason: "stop",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        reasoningTokens: 3,
        totalTokens: 18,
      },
    });

    expect(client.chat.completions.create.mock.calls[0]?.[0]).toEqual({
      model: "default-model",
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
    });
  });

  it("includes the system prompt and ignores client-side model overrides", async () => {
    client.chat.completions.create.mockResolvedValue({
      model: "default-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "answer",
          },
        },
      ],
    } as ChatCompletion);

    await provider.generateText({
      userPrompt: "hello",
      systemPrompt: "be concise",
    });

    expect(client.chat.completions.create.mock.calls[0]?.[0]).toEqual({
      model: "default-model",
      messages: [
        {
          role: "system",
          content: "be concise",
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    });
  });

  it("enables DeepSeek JSON mode for non-streaming JSON prompts", async () => {
    provider = new OpenAiCompatibleProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 30_000,
      },
      client as unknown as OpenAiClientLike,
    );
    client.chat.completions.create.mockResolvedValue({
      model: "deepseek-chat",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: '{"ok":true}',
          },
        },
      ],
    } as ChatCompletion);

    await provider.generateText({
      systemPrompt: "只输出 JSON。",
      userPrompt: '输出 JSON：{"ok": true}',
    });

    expect(client.chat.completions.create.mock.calls[0]?.[0]).toEqual({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "只输出 JSON。",
        },
        {
          role: "user",
          content: '输出 JSON：{"ok": true}',
        },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("does not enable DeepSeek JSON mode for other base URLs", async () => {
    client.chat.completions.create.mockResolvedValue({
      model: "default-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: '{"ok":true}',
          },
        },
      ],
    } as ChatCompletion);

    await provider.generateText({
      systemPrompt: "只输出 JSON。",
      userPrompt: '输出 JSON：{"ok": true}',
    });

    expect(client.chat.completions.create.mock.calls[0]?.[0]).toEqual({
      model: "default-model",
      messages: [
        {
          role: "system",
          content: "只输出 JSON。",
        },
        {
          role: "user",
          content: '输出 JSON：{"ok": true}',
        },
      ],
    });
  });

  it("passes abort signals to non-streaming completions", async () => {
    client.chat.completions.create.mockResolvedValue({
      model: "default-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "answer",
          },
        },
      ],
    } as ChatCompletion);
    const abortController = new AbortController();

    await provider.generateText(
      {
        userPrompt: "hello",
      },
      { signal: abortController.signal },
    );

    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      signal: abortController.signal,
    });
  });

  it("maps timeout and connection failures to Nest exceptions", async () => {
    client.chat.completions.create.mockRejectedValue(
      new APIConnectionTimeoutError(),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(GatewayTimeoutException);

    const connectionCause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    client.chat.completions.create.mockRejectedValue(
      new APIConnectionError({
        message: "network down",
        cause: connectionCause,
      }),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    const connectionLog = JSON.parse(
      String(
        loggerErrorSpy.mock.calls[loggerErrorSpy.mock.calls.length - 1]?.[0],
      ),
    ) as unknown;
    expect(connectionLog).toMatchObject({
      callType: "text",
      error: {
        cause: {
          code: "ECONNRESET",
          message: "socket hang up",
          name: "Error",
        },
        message: "network down",
        name: "APIConnectionError",
        status: null,
      },
      event: "llm_provider_request_failed",
    });
  });

  it("logs structured upstream details without request content or credentials", async () => {
    const headers = new Headers({
      "x-request-id": "upstream-request-123",
    });
    client.chat.completions.create.mockRejectedValue(
      new RateLimitError(
        429,
        {
          code: "rate_limit",
          internal: "response-body-details",
          message: "Too many requests",
          type: "rate_limit_error",
        },
        "rate limited",
        headers,
      ),
    );

    await expect(
      collectAsyncIterable(
        provider.streamText(
          {
            userPrompt: "sensitive prompt",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const serializedLog = String(loggerErrorSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(serializedLog)).toEqual({
      baseUrl: "https://example.com/v1",
      callType: "stream",
      error: {
        cause: null,
        code: "rate_limit",
        message: "Too many requests",
        name: "RateLimitError",
        requestId: "upstream-request-123",
        status: 429,
        type: "rate_limit_error",
      },
      event: "llm_provider_request_failed",
      model: "default-model",
    });
    expect(serializedLog).not.toContain("sensitive prompt");
    expect(serializedLog).not.toContain("test-key");
    expect(serializedLog).not.toContain("response-body-details");
  });

  it("maps provider-side request errors and empty responses", async () => {
    client.chat.completions.create.mockRejectedValue(
      new RateLimitError(429, {}, "rate limited", new Headers()),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    client.chat.completions.create.mockRejectedValue(
      new BadRequestError(400, {}, "bad request", new Headers()),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(BadGatewayException);

    client.chat.completions.create.mockResolvedValue({
      model: "default-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: null,
          },
        },
      ],
    } as ChatCompletion);

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it("streams text chunks and maps completed usage", async () => {
    provider = new OpenAiCompatibleProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 30_000,
      },
      client as unknown as OpenAiClientLike,
    );
    client.chat.completions.create.mockResolvedValue(
      createChatCompletionStream([
        {
          model: "deepseek-chat",
          choices: [
            {
              delta: {
                reasoning_content: "thinking",
              } as ChatCompletionChunk["choices"][number]["delta"],
              finish_reason: null,
              index: 0,
            },
          ],
        },
        {
          model: "deepseek-chat",
          choices: [
            {
              delta: {
                content: "hello",
              },
              finish_reason: null,
              index: 0,
            },
          ],
        },
        {
          model: "deepseek-chat",
          choices: [
            {
              delta: {
                content: " world",
              },
              finish_reason: "stop",
              index: 0,
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            completion_tokens_details: {
              reasoning_tokens: 2,
            },
            total_tokens: 7,
          },
        },
      ]),
    );
    const abortController = new AbortController();
    const telemetry = {
      onFirstContent: jest.fn(),
      onFirstReasoningContent: jest.fn(),
      onFirstUpstreamSse: jest.fn(),
    };

    await expect(
      collectAsyncIterable(
        provider.streamText(
          {
            userPrompt: "hello",
          },
          { signal: abortController.signal, telemetry },
        ),
      ),
    ).resolves.toEqual([
      {
        type: "reasoning",
        delta: "thinking",
      },
      {
        type: "chunk",
        delta: "hello",
      },
      {
        type: "chunk",
        delta: " world",
      },
      {
        type: "completed",
        model: "deepseek-chat",
        finishReason: "stop",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 2,
          totalTokens: 7,
        },
      },
    ]);
    expect(telemetry.onFirstUpstreamSse).toHaveBeenCalledTimes(1);
    expect(telemetry.onFirstReasoningContent).toHaveBeenCalledTimes(1);
    expect(telemetry.onFirstReasoningContent).toHaveBeenCalledWith(8);
    expect(telemetry.onFirstContent).toHaveBeenCalledTimes(1);
    expect(telemetry.onFirstContent).toHaveBeenCalledWith(5);
    expect(client.chat.completions.create.mock.calls[0]?.[0]).toEqual({
      model: "deepseek-chat",
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });
    expect(client.chat.completions.create.mock.calls[0]?.[1]).toEqual({
      signal: abortController.signal,
    });
  });

  it("rejects streamed completions without usage", async () => {
    client.chat.completions.create.mockResolvedValue(
      createChatCompletionStream([
        {
          model: "default-model",
          choices: [
            {
              delta: {
                content: "hello",
              },
              finish_reason: null,
              index: 0,
            },
          ],
        },
      ]),
    );

    await expect(
      collectAsyncIterable(
        provider.streamText(
          {
            userPrompt: "hello",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadGatewayException);
  });
});

async function* createChatCompletionStream(
  chunks: readonly Partial<ChatCompletionChunk>[],
): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk as ChatCompletionChunk;
  }
}

async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }

  return events;
}
