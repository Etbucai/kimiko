import { BadRequestException, Logger } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, LlmTextStreamEvent } from "./llm.provider";
import { LlmService } from "./llm.service";

describe("LlmService", () => {
  const originalLlmCallLogDir = process.env.KIMIKO_LLM_CALL_LOG_DIR;
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
    restoreLlmCallLogDir(originalLlmCallLogDir);
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

    const payloads = getLoggedPayloads(logSpy);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        callType: "text",
        event: "llm_call_started",
        requestMeta: {
          systemPromptChars: null,
          userPromptChars: 5,
        },
      }),
    );
    expect(payloads).toContainEqual(
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

    const iterator = llmService
      .streamTextFromParsedRequest(
        { userPrompt: "hello" },
        { signal: new AbortController().signal },
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "chunk", delta: "hello" },
    });
    expect(getLoggedPayloads(logSpy)).toEqual([
      expect.objectContaining({
        callType: "stream",
        event: "llm_call_started",
        requestMeta: {
          systemPromptChars: null,
          userPromptChars: 5,
        },
      }),
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        event: "llm_stream_first_event",
        eventType: "chunk",
      }),
      expect.objectContaining({
        deltaChars: 5,
        elapsedMs: expect.any(Number),
        event: "llm_stream_first_chunk",
      }),
    ]);

    await expect(iterator.next()).resolves.toEqual(
      expect.objectContaining({
        done: false,
        value: {
          type: "completed",
          model: "default-model",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
          },
        },
      }),
    );
    expect(getLoggedPayloads(logSpy)).toContainEqual(
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

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("writes non-stream LLM call details to a per-call file", async () => {
    const directory = await createTemporaryLogDirectory();
    process.env.KIMIKO_LLM_CALL_LOG_DIR = directory;
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
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

    try {
      await llmService.generateText({
        userPrompt: "  hello world  ",
        systemPrompt: "  be concise  ",
      });

      const record = await readSingleLogRecord(directory);
      expect(record).toEqual(
        expect.objectContaining({
          callType: "text",
          error: null,
          request: {
            systemPrompt: "be concise",
            userPrompt: "hello world",
          },
          requestMeta: {
            systemPromptChars: 10,
            userPromptChars: 11,
          },
          response: expect.objectContaining({
            finishReason: "stop",
            model: "default-model",
            text: "answer",
            textChars: 6,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
            },
          }),
          schemaVersion: 1,
          status: "completed",
        }),
      );
      expect(record.callId).toEqual(expect.any(String));
      expect(record.elapsedMs).toEqual(expect.any(Number));
      expect(record.startedAt).toEqual(expect.any(String));
      expect(record.completedAt).toEqual(expect.any(String));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes stream LLM input and accumulated output to a per-call file", async () => {
    const directory = await createTemporaryLogDirectory();
    process.env.KIMIKO_LLM_CALL_LOG_DIR = directory;
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    llmProvider.streamText.mockReturnValue(
      createLlmStream([
        { type: "chunk", delta: "hello " },
        { type: "chunk", delta: "world" },
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

    try {
      await collectAsyncIterable(
        llmService.streamTextFromParsedRequest(
          {
            userPrompt: " hello ",
          },
          { signal: new AbortController().signal },
        ),
      );

      const record = await readSingleLogRecord(directory);
      expect(record).toEqual(
        expect.objectContaining({
          callType: "stream",
          error: null,
          request: {
            userPrompt: "hello",
          },
          response: expect.objectContaining({
            finishReason: null,
            model: "default-model",
            text: "hello world",
            textChars: 11,
            usage: {
              inputTokens: 7,
              outputTokens: 3,
              totalTokens: 10,
            },
          }),
          schemaVersion: 1,
          status: "completed",
        }),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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

function getLoggedPayloads(
  logSpy: jest.SpyInstance<void, Parameters<Logger["log"]>>,
): Record<string, unknown>[] {
  return logSpy.mock.calls.map((call) => parseLoggedJson(call[0]));
}

async function createTemporaryLogDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kimiko-llm-log-"));
}

async function readSingleLogRecord(
  directory: string,
): Promise<Record<string, unknown>> {
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const fileName = files[0];
  if (fileName === undefined) {
    throw new Error("Expected one LLM call log file");
  }

  const fileContent = await readFile(join(directory, fileName), "utf8");
  const parsedValue: unknown = JSON.parse(fileContent);
  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Expected LLM call log file to contain a JSON object");
  }

  return parsedValue as Record<string, unknown>;
}

function restoreLlmCallLogDir(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.KIMIKO_LLM_CALL_LOG_DIR;
    return;
  }

  process.env.KIMIKO_LLM_CALL_LOG_DIR = value;
}
