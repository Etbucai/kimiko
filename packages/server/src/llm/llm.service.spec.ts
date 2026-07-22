import { BadRequestException } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import type { LlmProvider, LlmTextStreamEvent } from "./llm.provider";
import { LlmService } from "./llm.service";

describe("LlmService", () => {
  let llmProvider: jest.Mocked<LlmProvider>;
  let llmService: LlmService;

  beforeEach(() => {
    llmProvider = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
      >(),
      streamText: jest.fn<
        AsyncIterable<LlmTextStreamEvent>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
      >(),
    };
    llmService = new LlmService(llmProvider);
  });

  it("normalizes prompts and forwards the request to the provider", async () => {
    llmProvider.generateText.mockResolvedValue({
      text: "answer",
      model: "default-model",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    await expect(
      llmService.generateText({
        userPrompt: "  hello world  ",
        systemPrompt: "  be concise  ",
      }),
    ).resolves.toEqual({
      text: "answer",
      model: "default-model",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    expect(llmProvider.generateText.mock.calls[0]?.[0]).toEqual({
      userPrompt: "hello world",
      systemPrompt: "be concise",
    });
  });

  it("drops blank optional fields before calling the provider", async () => {
    llmProvider.generateText.mockResolvedValue({
      text: "answer",
      model: "default-model",
    });

    await llmService.generateText({
      userPrompt: "hello",
      systemPrompt: "   ",
    });

    expect(llmProvider.generateText.mock.calls[0]?.[0]).toEqual({
      userPrompt: "hello",
    });
  });

  it("forwards abort signals for internal parsed requests", async () => {
    const abortController = new AbortController();
    llmProvider.generateText.mockResolvedValue({
      text: "answer",
      model: "default-model",
    });

    await llmService.generateTextFromParsedRequest(
      {
        userPrompt: " hello ",
      },
      { signal: abortController.signal },
    );

    expect(llmProvider.generateText.mock.calls[0]?.[0]).toEqual({
      userPrompt: "hello",
    });
    expect(llmProvider.generateText.mock.calls[0]?.[1]).toEqual({
      signal: abortController.signal,
    });
  });

  it("rejects empty and oversized prompts", async () => {
    await expect(
      llmService.generateText({
        userPrompt: "   ",
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      llmService.generateText({
        userPrompt: "a".repeat(20_001),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects unsupported generation settings on the HTTP contract", async () => {
    await expect(
      llmService.generateText({
        userPrompt: "hello",
        model: "client-model",
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
