import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import type { LlmProvider, LlmTextStreamEvent } from "../llm/llm.provider";
import { LlmService } from "../llm/llm.service";
import {
  buildRewriteStoryLlmRequestFromContext,
  buildStoryLlmRequestFromContext,
  STORY_SYSTEM_PROMPT,
  StoryService,
} from "./story.service";

describe("StoryService", () => {
  let llmProvider: jest.Mocked<LlmProvider>;
  let storyService: StoryService;

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
    storyService = new StoryService(new LlmService(llmProvider));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects invalid request bodies", async () => {
    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "   ",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "   ",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
            model: "client-model",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("keeps LLM provider failures mapped by the LLM layer", async () => {
    llmProvider.streamText.mockReturnValue(
      createFailingStream(
        new ServiceUnavailableException("LLM provider is unavailable"),
      ),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("streams story chunks and completes with accumulated metadata", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_050);
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "chunk",
          delta: "林夏",
        },
        {
          type: "chunk",
          delta: "走向钟楼。",
        },
        {
          type: "completed",
          model: "story-model",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
        },
      ]),
    );

    const events = await collectAsyncIterable(
      storyService.streamContinueStory(
        {
          storyText: "  雨停以后。  ",
          instruction: "  继续调查。  ",
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "林夏",
        sequence: 1,
      },
      {
        type: "chunk",
        delta: "走向钟楼。",
        sequence: 2,
      },
      {
        type: "completed",
        continuedStory: "林夏走向钟楼。",
        model: "story-model",
        elapsedMs: 50,
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
        },
      },
    ]);
    expect(llmProvider.streamText.mock.calls[0]?.[0]).toEqual({
      systemPrompt: STORY_SYSTEM_PROMPT,
      userPrompt: [
        "故事正文：",
        "雨停以后。",
        "",
        "续写指令：",
        "继续调查。",
      ].join("\n"),
    });
  });

  it("rejects empty streamed output", async () => {
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "completed",
          model: "story-model",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            totalTokens: 1,
          },
        },
      ]),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadGatewayException);
  });

  it("rejects empty streamed model", async () => {
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "chunk",
          delta: "continued story",
        },
        {
          type: "completed",
          model: "   ",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
      ]),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadGatewayException);
  });

  it("builds trimmed storyline prompts without initial story text", () => {
    const request = buildStoryLlmRequestFromContext({
      currentInstruction: "继续追查钟楼。",
      historyRounds: [
        {
          roundIndex: 4,
          instruction: "调查旧书店。",
          generatedText: "林夏回到旧书店。",
        },
        {
          roundIndex: 5,
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      historyWasTrimmed: true,
    });

    expect(request.systemPrompt).toBe(STORY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("近期故事正文片段：");
    expect(request.userPrompt).toContain("第 4 轮续写：");
    expect(request.userPrompt).toContain("林夏回到旧书店。");
    expect(request.userPrompt).toContain("近期续写指令轨迹：");
    expect(request.userPrompt).toContain("第 5 轮指令：");
    expect(request.userPrompt).toContain("当前续写指令：");
    expect(request.userPrompt).not.toContain("故事正文：\n");
  });

  it("injects character summaries before recent history", () => {
    const request = buildStoryLlmRequestFromContext({
      currentInstruction: "让林夏继续调查。",
      characterSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "调查旧钟楼的记者",
            relationships: ["与周岚是旧识"],
            motivation: "查清钟楼失踪案",
            currentStatus: "正在前往钟楼",
          },
        ],
      },
      initialStoryText: "雨停以后。",
      historyRounds: [
        {
          roundIndex: 1,
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      historyWasTrimmed: false,
    });

    const summaryIndex = request.userPrompt.indexOf("角色摘要：");
    const storyIndex = request.userPrompt.indexOf("故事正文：");
    const historyIndex = request.userPrompt.indexOf("近期续写轨迹：");

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(storyIndex).toBeGreaterThan(summaryIndex);
    expect(historyIndex).toBeGreaterThan(storyIndex);
    expect(request.userPrompt).toContain('"name": "林夏"');
    expect(request.userPrompt).toContain("调查旧钟楼的记者");
  });

  it("builds rewrite prompts from prior context and original generation", () => {
    const request = buildRewriteStoryLlmRequestFromContext({
      rewriteInstruction: "文风更加轻快，增加气味描写。",
      originalInstruction: "前往钟楼。",
      originalGeneratedText: "林夏走向钟楼。",
      characterSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "调查旧钟楼的记者",
            relationships: ["与周岚是旧识"],
            motivation: "查清钟楼失踪案",
            currentStatus: "正在前往钟楼",
          },
        ],
      },
      initialStoryText: "雨停以后。",
      historyRoundsBeforeTarget: [
        {
          roundIndex: 1,
          instruction: "调查旧书店。",
          generatedText: "林夏回到旧书店。",
        },
      ],
      historyWasTrimmed: false,
    });

    expect(request.systemPrompt).toBe(STORY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("角色摘要：");
    expect(request.userPrompt).toContain("故事正文：");
    expect(request.userPrompt).toContain("目标段之前的近期续写轨迹：");
    expect(request.userPrompt).toContain("原续写指令：");
    expect(request.userPrompt).toContain("前往钟楼。");
    expect(request.userPrompt).toContain("原生成正文：");
    expect(request.userPrompt).toContain("林夏走向钟楼。");
    expect(request.userPrompt).toContain("重写指令：");
    expect(request.userPrompt).toContain("文风更加轻快");
    expect(request.userPrompt).toContain(
      "请只输出用于替换原生成正文的新正文。",
    );
    expect(request.userPrompt).not.toContain("当前续写指令：");
  });
});

async function* createStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
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

function createFailingStream(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          throw error;
        },
      };
    },
  };
}
