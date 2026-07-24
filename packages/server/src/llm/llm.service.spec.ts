import { BadRequestException, Logger } from "@nestjs/common";
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

  afterEach(() => {
    jest.restoreAllMocks();
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

  it("logs non-stream LLM calls with usage and elapsed time", async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
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

    await llmService.generateTextFromParsedRequest({
      userPrompt: "hello",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = parseLoggedJson(logSpy.mock.calls[0]?.[0]);
    expect(payload).toEqual(
      expect.objectContaining({
        callType: "text",
        elapsedMs: expect.any(Number),
        event: "llm_call_completed",
        finishReason: "stop",
        model: "default-model",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      }),
    );
  });

  it("logs stream LLM calls with usage and elapsed time", async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    llmProvider.streamText.mockReturnValue(
      createLlmStream([
        { type: "chunk", delta: "hello" },
        {
          type: "completed",
          model: "default-model",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
          },
        },
      ]),
    );

    const events = await collectAsyncIterable(
      llmService.streamTextFromParsedRequest(
        {
          userPrompt: "hello",
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(events).toEqual([
      { type: "chunk", delta: "hello" },
      {
        type: "completed",
        model: "default-model",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
      },
    ]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = parseLoggedJson(logSpy.mock.calls[0]?.[0]);
    expect(payload).toEqual(
      expect.objectContaining({
        callType: "stream",
        elapsedMs: expect.any(Number),
        event: "llm_call_completed",
        model: "default-model",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
        },
      }),
    );
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

async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }

  return events;
}

async function* createLlmStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function parseLoggedJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("Expected log message to be a string");
  }

  const parsedValue: unknown = JSON.parse(value);
  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Expected log message to be a JSON object");
  }

  return parsedValue as Record<string, unknown>;
}
