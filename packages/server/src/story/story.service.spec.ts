import {
  BadGatewayException,
  BadRequestException,
  Logger,
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
  buildStorySystemPrompt,
  STORY_DIALOGUE_SYSTEM_PROMPT,
  STORY_SYSTEM_PROMPT,
  StoryService,
  type StoryHistoryRound,
  type StoryWriterContextBundle,
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
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_050);
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "reasoning",
          delta: "先衔接雨停后的场景。",
        },
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
        type: "reasoning",
        delta: "先衔接雨停后的场景。",
        sequence: 1,
      },
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
    const historyRounds = [
      {
        segmentId: "4",
        roundIndex: 4,
        generationMode: "append" as const,
        instruction: "调查旧书店。",
        generatedText: "林夏回到旧书店。",
      },
      {
        segmentId: "5",
        roundIndex: 5,
        generationMode: "append" as const,
        instruction: "前往钟楼。",
        generatedText: "林夏走向钟楼。",
      },
    ];
    const request = buildStoryLlmRequestFromContext({
      currentInstruction: "继续追查钟楼。",
      contextBundle: createContextBundle({
        recentHistoryRounds: historyRounds,
        historyWasTrimmed: true,
      }),
    });

    expect(request.systemPrompt).toBe(STORY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("近期故事正文片段");
    expect(request.userPrompt).toContain("第 4 轮续写正文：");
    expect(request.userPrompt).toContain("林夏回到旧书店。");
    expect(request.userPrompt).toContain("近期生成指令轨迹：");
    expect(request.userPrompt).toContain("第 5 轮续写指令：");
    expect(request.userPrompt).toContain("当前续写指令：");
    expect(request.userPrompt).not.toContain("故事正文：\n");
  });

  it("injects story context before recent history", () => {
    const request = buildStoryLlmRequestFromContext({
      currentInstruction: "让林夏继续调查。",
      initialStoryText: "雨停以后。",
      contextBundle: createContextBundle({
        recentHistoryRounds: [
          {
            segmentId: "2",
            roundIndex: 1,
            generationMode: "append",
            instruction: "前往钟楼。",
            generatedText: "林夏走向钟楼。",
          },
        ],
      }),
    });

    const contextIndex = request.userPrompt.indexOf("当前可观察世界事实：");
    const storyIndex = request.userPrompt.indexOf("故事正文：");
    const historyIndex = request.userPrompt.indexOf("近期生成轨迹");

    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(storyIndex).toBeGreaterThan(contextIndex);
    expect(historyIndex).toBeGreaterThan(storyIndex);
    expect(request.userPrompt).toContain("角色 [char_1] 林夏");
    expect(request.userPrompt).toContain("调查旧钟楼的记者");
  });

  it("builds append prompts with a custom target length", () => {
    const request = buildStoryLlmRequestFromContext({
      currentInstruction: "让林夏继续调查。",
      targetLength: 500,
      contextBundle: createContextBundle(),
    });

    expect(request.systemPrompt).toBe(buildStorySystemPrompt(500));
    expect(request.systemPrompt).toContain(
      "输出目标长度约 500 字，允许合理浮动。",
    );
  });

  it("builds rewrite prompts from prior context and original generation", () => {
    const request = buildRewriteStoryLlmRequestFromContext({
      rewriteInstruction: "文风更加轻快，增加气味描写。",
      originalInstruction: "前往钟楼。",
      originalGeneratedText: "林夏走向钟楼。",
      initialStoryText: "雨停以后。",
      targetLength: 250,
      contextBundle: createContextBundle({
        recentHistoryRounds: [
          {
            segmentId: "2",
            roundIndex: 1,
            generationMode: "append",
            instruction: "调查旧书店。",
            generatedText: "林夏回到旧书店。",
          },
        ],
      }),
    });

    expect(request.systemPrompt).toBe(buildStorySystemPrompt(250));
    expect(request.userPrompt).toContain("当前可观察世界事实：");
    expect(request.userPrompt).toContain("故事正文：");
    expect(request.userPrompt).toContain("目标段之前的近期生成轨迹");
    expect(request.userPrompt).toContain("原续写指令：");
    expect(request.userPrompt).toContain("前往钟楼。");
    expect(request.userPrompt).toContain("原生成正文：");
    expect(request.userPrompt).toContain("林夏走向钟楼。");
    expect(request.userPrompt).toContain("重写指令：");
    expect(request.userPrompt).toContain("文风更加轻快");
    expect(request.userPrompt).toContain(
      "请输出一整段用于替换原生成正文的新正文。",
    );
    expect(request.userPrompt).toContain("不能只从需要修改的位置继续写。");
    expect(request.userPrompt).toContain(
      "请尽量保留原生成正文中与指令不冲突的大部分内容",
    );
    expect(request.userPrompt).not.toContain("当前续写指令：");
  });

  it("builds dialogue prompts with current scene and short interaction rules", () => {
    const request = buildDialogueStoryLlmRequestFromContext({
      input: "方源朝厨房喊，让程溪帮他拿奶茶。",
      currentSceneText: [
        "章节正文：",
        "方源靠在沙发上，程溪在厨房里翻冰箱。",
        "",
        "互动：",
        "程溪回头看了他一眼。",
      ].join("\n"),
      contextBundle: createContextBundle({
        recentHistoryRounds: [
          {
            segmentId: "3",
            roundIndex: 1,
            generationMode: "dialogue",
            instruction: "方源让程溪拿奶茶。",
            generatedText: "程溪没好气地瞪了他一眼。",
          },
        ],
      }),
    });

    expect(request.systemPrompt).toBe(STORY_DIALOGUE_SYSTEM_PROMPT);
    expect(request.systemPrompt).not.toContain("800-1200 字");
    expect(request.systemPrompt).toContain(
      "最终输出必须同时包含两部分：先把用户输入润色成故事正文，再写另一个角色的互动反应。",
    );
    expect(request.systemPrompt).toContain("不要只输出另一角色的回应");
    expect(request.userPrompt).toContain("当前场景：");
    expect(request.userPrompt).toContain("本轮互动输入：");
    expect(request.userPrompt).toContain("方源朝厨房喊");
    expect(request.userPrompt).toContain(
      "本轮互动正文必须先呈现用户输入的润色版本，再呈现另一个角色的反应。",
    );
    expect(request.userPrompt).toContain(
      "不要省略用户输入对应的动作或台词，不要只写另一角色如何回应。",
    );
    expect(request.userPrompt).toContain("第 1 轮互动输入：");
    expect(request.userPrompt).toContain("第 1 轮互动正文：");
    expect(request.userPrompt).toContain("只输出“无事发生”");
  });

  it("builds dialogue rewrite prompts from original input and text", () => {
    const request = buildRewriteDialogueLlmRequestFromContext({
      rewriteInstruction: "语气更嫌弃一点。",
      originalInput: "方源让程溪拿奶茶。",
      originalGeneratedText: "程溪叹了口气，还是走向厨房。",
      currentSceneText: "章节正文：\n方源靠在沙发上，程溪站在厨房门口。",
      contextBundle: createContextBundle({
        recentHistoryRounds: [
          {
            segmentId: "2",
            roundIndex: 1,
            generationMode: "append",
            instruction: "进入客厅。",
            generatedText: "两人在客厅里拌嘴。",
          },
        ],
      }),
    });

    expect(request.systemPrompt).toBe(STORY_DIALOGUE_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("原互动输入：");
    expect(request.userPrompt).toContain("方源让程溪拿奶茶。");
    expect(request.userPrompt).toContain("原互动正文：");
    expect(request.userPrompt).toContain("重写要求：");
    expect(request.userPrompt).toContain("语气更嫌弃一点。");
    expect(request.userPrompt).toContain(
      "新互动正文必须同时包含原互动输入的润色版本和另一个角色的反应。",
    );
    expect(request.userPrompt).toContain("不要只输出另一角色的回应");
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

function createContextBundle(
  options: Readonly<{
    recentHistoryRounds?: readonly StoryHistoryRound[];
    historyWasTrimmed?: boolean;
  }> = {},
): StoryWriterContextBundle {
  return {
    storyContext: {
      worldFacts: [
        {
          id: "fact_1",
          kind: "environment",
          text: "旧钟楼的门从里面锁住了。",
          status: "active",
          visibility: "observable",
          sourceSegmentIds: ["1"],
        },
      ],
      characters: [
        {
          id: "char_1",
          name: "林夏",
          aliases: ["程溪"],
          identity: "调查旧钟楼的记者",
          traits: ["谨慎"],
          relationships: [],
          motivations: ["查清钟楼失踪案"],
          currentStatus: "正在前往钟楼",
          beliefs: [
            {
              text: "她知道旧钟楼的门锁住了。",
              truthStatus: "true",
              factIds: ["fact_1"],
              sourceSegmentIds: ["1"],
            },
          ],
          opinions: [],
          actionTendencies: ["先观察再行动"],
          sourceSegmentIds: ["1"],
        },
      ],
      currentScene: {
        location: "旧钟楼门口",
        timeLabel: "雨后",
        presentCharacterIds: ["char_1"],
        observableFactIds: ["fact_1"],
        sceneStatus: "林夏正在调查钟楼。",
        sourceSegmentIds: ["1"],
      },
    },
    observableFacts: [
      {
        id: "fact_1",
        kind: "environment",
        text: "旧钟楼的门从里面锁住了。",
        status: "active",
        visibility: "observable",
        sourceSegmentIds: ["1"],
      },
    ],
    activeCharacters: [
      {
        id: "char_1",
        name: "林夏",
        aliases: ["程溪"],
        identity: "调查旧钟楼的记者",
        traits: ["谨慎"],
        relationships: [],
        motivations: ["查清钟楼失踪案"],
        currentStatus: "正在前往钟楼",
        beliefs: [
          {
            text: "她知道旧钟楼的门锁住了。",
            truthStatus: "true",
            factIds: ["fact_1"],
            sourceSegmentIds: ["1"],
          },
        ],
        opinions: [],
        actionTendencies: ["先观察再行动"],
        sourceSegmentIds: ["1"],
      },
    ],
    recentHistoryRounds: options.recentHistoryRounds ?? [],
    historyWasTrimmed: options.historyWasTrimmed ?? false,
    contextWasMissing: false,
  };
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
