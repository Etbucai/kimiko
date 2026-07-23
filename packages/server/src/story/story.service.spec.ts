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
  buildDialogueStoryLlmRequestFromContext,
  buildRewriteStoryLlmRequestFromContext,
  buildRewriteDialogueLlmRequestFromContext,
  buildStoryLlmRequestFromContext,
  STORY_DIALOGUE_SYSTEM_PROMPT,
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
          generationMode: "append",
          instruction: "调查旧书店。",
          generatedText: "林夏回到旧书店。",
        },
        {
          roundIndex: 5,
          generationMode: "append",
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      historyWasTrimmed: true,
    });

    expect(request.systemPrompt).toBe(STORY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("近期故事正文片段：");
    expect(request.userPrompt).toContain("第 4 轮续写正文：");
    expect(request.userPrompt).toContain("林夏回到旧书店。");
    expect(request.userPrompt).toContain("近期生成指令轨迹：");
    expect(request.userPrompt).toContain("第 5 轮续写指令：");
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
          generationMode: "append",
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      historyWasTrimmed: false,
    });

    const summaryIndex = request.userPrompt.indexOf("角色摘要：");
    const storyIndex = request.userPrompt.indexOf("故事正文：");
    const historyIndex = request.userPrompt.indexOf("近期生成轨迹：");

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
          generationMode: "append",
          instruction: "调查旧书店。",
          generatedText: "林夏回到旧书店。",
        },
      ],
      historyWasTrimmed: false,
    });

    expect(request.systemPrompt).toBe(STORY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("角色摘要：");
    expect(request.userPrompt).toContain("故事正文：");
    expect(request.userPrompt).toContain("目标段之前的近期生成轨迹：");
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

  it("builds dialogue prompts with current scene and short interaction rules", () => {
    const request = buildDialogueStoryLlmRequestFromContext({
      input: "大凡朝厨房喊，让馥冰帮他拿奶茶。",
      currentSceneText: [
        "章节正文：",
        "大凡靠在沙发上，馥冰在厨房里翻冰箱。",
        "",
        "互动：",
        "馥冰回头看了他一眼。",
      ].join("\n"),
      characterSummary: {
        characters: [
          {
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["和大凡经常拌嘴"],
            motivation: "",
            currentStatus: "正在厨房",
          },
        ],
      },
      recentHistoryRounds: [
        {
          roundIndex: 1,
          generationMode: "dialogue",
          instruction: "大凡让馥冰拿奶茶。",
          generatedText: "馥冰没好气地瞪了他一眼。",
        },
      ],
      historyWasTrimmed: false,
    });

    expect(request.systemPrompt).toBe(STORY_DIALOGUE_SYSTEM_PROMPT);
    expect(request.systemPrompt).not.toContain("800-1200 字");
    expect(request.userPrompt).toContain("当前场景：");
    expect(request.userPrompt).toContain("本轮互动输入：");
    expect(request.userPrompt).toContain("大凡朝厨房喊");
    expect(request.userPrompt).toContain("第 1 轮互动输入：");
    expect(request.userPrompt).toContain("第 1 轮互动正文：");
    expect(request.userPrompt).toContain("只输出“无事发生”");
  });

  it("builds dialogue rewrite prompts from original input and text", () => {
    const request = buildRewriteDialogueLlmRequestFromContext({
      rewriteInstruction: "语气更嫌弃一点。",
      originalInput: "大凡让馥冰拿奶茶。",
      originalGeneratedText: "馥冰叹了口气，还是走向厨房。",
      currentSceneText: "章节正文：\n大凡靠在沙发上，馥冰站在厨房门口。",
      recentHistoryRoundsBeforeTarget: [
        {
          roundIndex: 1,
          generationMode: "append",
          instruction: "进入客厅。",
          generatedText: "两人在客厅里拌嘴。",
        },
      ],
      historyWasTrimmed: false,
    });

    expect(request.systemPrompt).toBe(STORY_DIALOGUE_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("原互动输入：");
    expect(request.userPrompt).toContain("大凡让馥冰拿奶茶。");
    expect(request.userPrompt).toContain("原互动正文：");
    expect(request.userPrompt).toContain("重写要求：");
    expect(request.userPrompt).toContain("语气更嫌弃一点。");
    expect(request.userPrompt).toContain("不要扩写成大段续写");
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
