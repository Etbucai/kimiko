import {
  BadGatewayException,
  GatewayTimeoutException,
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
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { OpenAiCompatibleProvider } from "./openai-compatible.provider";

type ChatCompletionCreateMock = jest.Mock<
  Promise<ChatCompletion>,
  [ChatCompletionCreateParamsNonStreaming]
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
  let provider: OpenAiCompatibleProvider;

  beforeEach(() => {
    const createMock: ChatCompletionCreateMock = jest.fn<
      Promise<ChatCompletion>,
      [ChatCompletionCreateParamsNonStreaming]
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
      client,
    );
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

  it("maps timeout and connection failures to Nest exceptions", async () => {
    client.chat.completions.create.mockRejectedValue(
      new APIConnectionTimeoutError(),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(GatewayTimeoutException);

    client.chat.completions.create.mockRejectedValue(
      new APIConnectionError({ message: "network down" }),
    );

    await expect(
      provider.generateText({
        userPrompt: "hello",
      }),
    ).rejects.toThrow(ServiceUnavailableException);
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
});
