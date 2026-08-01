import type { CompletedStorylineSnapshot } from "@kimiko/schema";
import type {
  StoryService,
  StoryStreamEvent,
  StoryWriterContextBundle,
} from "../story/story.service";
import type { StorylineContextExtractionService } from "./storyline-context-extraction.service";
import { emptyStoryContextSnapshot } from "./storyline-context.types";
import type { StorySettingService } from "./story-setting.service";
import type { StorylineLockService } from "./storyline-lock.service";
import type { StorylineService } from "./storyline.service";
import {
  buildCreateFromSettingInitialText,
  StorylineGenerationService,
} from "./storyline-generation.service";

describe("StorylineGenerationService", () => {
  let storylineService: jest.Mocked<
    Pick<
      StorylineService,
      | "getStorylineForUser"
      | "buildLlmContext"
      | "buildDialogueLlmContext"
      | "buildRewriteLlmContext"
      | "saveCreatedStoryline"
      | "saveAppendedSegment"
      | "saveDialogueSegmentWithoutContextUpdate"
      | "saveRewrittenSegment"
    >
  >;
  let storyService: jest.Mocked<
    Pick<
      StoryService,
      | "streamContinueStoryFromContext"
      | "streamCreateStoryFromSetting"
      | "streamDialogueStoryFromContext"
      | "streamRewriteDialogueFromContext"
      | "streamRewriteStoryFromContext"
    >
  >;
  let storySettingService: jest.Mocked<
    Pick<StorySettingService, "getRequiredSettingForUser">
  >;
  let lockService: jest.Mocked<
    Pick<StorylineLockService, "acquireCreateLock" | "acquireStorylineLock">
  >;
  let contextExtractionService: jest.Mocked<
    Pick<StorylineContextExtractionService, "extractNextBatch" | "getState">
  >;
  let releaseLock: jest.Mock;
  let generationService: StorylineGenerationService;

  beforeEach(() => {
    storylineService = {
      getStorylineForUser: jest.fn(),
      buildLlmContext: jest.fn(),
      buildDialogueLlmContext: jest.fn(),
      buildRewriteLlmContext: jest.fn(),
      saveCreatedStoryline: jest.fn(),
      saveAppendedSegment: jest.fn(),
      saveDialogueSegmentWithoutContextUpdate: jest.fn(),
      saveRewrittenSegment: jest.fn(),
    };
    storyService = {
      streamContinueStoryFromContext: jest.fn(),
      streamCreateStoryFromSetting: jest.fn(),
      streamDialogueStoryFromContext: jest.fn(),
      streamRewriteDialogueFromContext: jest.fn(),
      streamRewriteStoryFromContext: jest.fn(),
    };
    storySettingService = {
      getRequiredSettingForUser: jest.fn(),
    };
    releaseLock = jest.fn();
    lockService = {
      acquireCreateLock: jest.fn((_userId: string) => releaseLock),
      acquireStorylineLock: jest.fn((_storylineId: string) => releaseLock),
    };
    contextExtractionService = {
      extractNextBatch: jest.fn(),
      getState: jest.fn().mockResolvedValue({
        context: null,
        extractedThroughOrderIndex: 0,
        pendingRoundCount: 0,
      }),
    };
    generationService = new StorylineGenerationService(
      storylineService as unknown as StorylineService,
      storyService as unknown as StoryService,
      storySettingService as unknown as StorySettingService,
      lockService as unknown as StorylineLockService,
      contextExtractionService as unknown as StorylineContextExtractionService,
    );
  });

  it("streams append chunks, forwards target length and saves the appended segment", async () => {
    const abortController = new AbortController();
    const previousContext = createContextSnapshot();
    const writerContext = {
      currentInstruction: "进入钟楼。",
      targetLength: 750,
      initialStoryText: "雨停以后。",
      contextBundle: createContextBundle(previousContext),
    };
    const completedStoryline = createCompletedStoryline({
      latestText: "林夏推开钟楼木门。",
    });

    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildLlmContext.mockResolvedValue(writerContext);
    storyService.streamContinueStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "reasoning",
          delta: "先让角色进入钟楼。",
          sequence: 1,
        },
        {
          type: "chunk",
          delta: "林夏",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: "林夏推开钟楼木门。",
          model: "append-model",
          elapsedMs: 24,
          usage: {
            inputTokens: 5,
            outputTokens: 6,
            totalTokens: 11,
          },
        },
      ]),
    );
    contextExtractionService.getState.mockResolvedValue({
      context: previousContext,
      extractedThroughOrderIndex: 0,
      pendingRoundCount: 10,
    });
    contextExtractionService.extractNextBatch.mockResolvedValue({
      extractedRoundCount: 10,
      pendingRoundCount: 0,
    });
    storylineService.saveAppendedSegment.mockResolvedValue(completedStoryline);

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "append",
            storylineId: "10",
            instruction: "进入钟楼。",
            targetLength: 750,
          },
        },
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "reasoning",
        delta: "先让角色进入钟楼。",
        sequence: 1,
      },
      {
        type: "chunk",
        delta: "林夏",
        sequence: 1,
      },
      { type: "contextStarted" },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(storylineService.buildLlmContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "1",
        storylineId: "10",
        currentInstruction: "进入钟楼。",
        targetLength: 750,
      }),
    );
    expect(storyService.streamContinueStoryFromContext).toHaveBeenCalledWith(
      writerContext,
      { signal: abortController.signal },
    );
    expect(contextExtractionService.extractNextBatch).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      signal: abortController.signal,
    });
    expect(storylineService.saveAppendedSegment).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      instruction: "进入钟楼。",
      targetLength: 750,
      generatedText: "林夏推开钟楼木门。",
      model: "append-model",
      elapsedMs: 24,
      usage: {
        inputTokens: 5,
        outputTokens: 6,
        totalTokens: 11,
      },
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved story completed when automatic context extraction fails", async () => {
    const completedStoryline = createCompletedStoryline({
      latestText: "林夏推开钟楼木门。",
    });
    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildLlmContext.mockResolvedValue({
      currentInstruction: "进入钟楼。",
      targetLength: 750,
      contextBundle: createContextBundle(),
    });
    storyService.streamContinueStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "completed",
          continuedStory: "林夏推开钟楼木门。",
          model: "append-model",
          elapsedMs: 24,
          usage: {
            inputTokens: 5,
            outputTokens: 6,
            totalTokens: 11,
          },
        },
      ]),
    );
    storylineService.saveAppendedSegment.mockResolvedValue(completedStoryline);
    contextExtractionService.getState.mockResolvedValue({
      context: null,
      extractedThroughOrderIndex: 0,
      pendingRoundCount: 10,
    });
    contextExtractionService.extractNextBatch.mockRejectedValue(
      new Error("context provider failed"),
    );

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "append",
            storylineId: "10",
            instruction: "进入钟楼。",
            targetLength: 750,
          },
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(events).toEqual([
      { type: "contextStarted" },
      {
        type: "contextFailed",
        message: "正文已保存，但上下文提取失败，可在调试页手动重试",
      },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
  });

  it("creates a storyline from a saved setting and opening", async () => {
    const abortController = new AbortController();
    const completedStoryline = createCompletedStoryline({
      latestText: "雨夜里，林夏推开旧书店的门。",
    });
    const initialStoryText = buildCreateFromSettingInitialText({
      settingContent: "赛博城邦里，主角经营一家旧书店。",
      opening: "从雨夜访客开始。",
    });

    storySettingService.getRequiredSettingForUser.mockResolvedValue({
      id: "5",
      content: "赛博城邦里，主角经营一家旧书店。",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    storyService.streamCreateStoryFromSetting.mockReturnValue(
      createStoryStream([
        {
          type: "chunk",
          delta: "雨夜里，",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: "雨夜里，林夏推开旧书店的门。",
          model: "create-setting-model",
          elapsedMs: 31,
          usage: {
            inputTokens: 10,
            outputTokens: 11,
            totalTokens: 21,
          },
        },
      ]),
    );
    storylineService.saveCreatedStoryline.mockResolvedValue(completedStoryline);

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "createFromSetting",
            settingId: "5",
            opening: "从雨夜访客开始。",
          },
        },
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "雨夜里，",
        sequence: 1,
      },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(storySettingService.getRequiredSettingForUser).toHaveBeenCalledWith({
      userId: "1",
      settingId: "5",
    });
    expect(lockService.acquireCreateLock).toHaveBeenCalledWith("1");
    expect(storyService.streamCreateStoryFromSetting).toHaveBeenCalledWith(
      {
        settingContent: "赛博城邦里，主角经营一家旧书店。",
        opening: "从雨夜访客开始。",
      },
      { signal: abortController.signal },
    );
    expect(storylineService.saveCreatedStoryline).toHaveBeenCalledWith({
      userId: "1",
      initialStoryText,
      instruction: "从雨夜访客开始。",
      generatedText: "雨夜里，林夏推开旧书店的门。",
      model: "create-setting-model",
      elapsedMs: 31,
      usage: {
        inputTokens: 10,
        outputTokens: 11,
        totalTokens: 21,
      },
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("streams rewrite chunks, updates context and saves in place", async () => {
    const abortController = new AbortController();
    const previousContext = createContextSnapshot();
    const writerContext = {
      rewriteInstruction: "文风更加轻快。",
      originalInstruction: "进入钟楼。",
      originalGeneratedText: "林夏推开钟楼木门。",
      initialStoryText: "雨停以后。",
      contextBundle: createContextBundle(previousContext),
    };
    const completedStoryline = createCompletedStoryline({
      latestText: "林夏轻快地推开钟楼木门。",
    });

    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildRewriteLlmContext.mockResolvedValue({
      storyline: {
        id: 10,
        externalId: "10",
        userId: 1,
      },
      targetSegmentId: "3",
      targetGenerationMode: "append",
      previousContext,
      writerContext,
      contextHistoryRounds: [
        {
          segmentId: "2",
          roundIndex: 1,
          generationMode: "append",
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      initialStoryText: writerContext.initialStoryText,
    });
    storyService.streamRewriteStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "chunk",
          delta: "林夏",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: "林夏轻快地推开钟楼木门。",
          model: "rewrite-model",
          elapsedMs: 42,
          usage: {
            inputTokens: 7,
            outputTokens: 8,
            totalTokens: 15,
          },
        },
      ]),
    );
    storylineService.saveRewrittenSegment.mockResolvedValue(completedStoryline);

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "rewrite",
            storylineId: "10",
            segmentId: "3",
            instruction: "文风更加轻快。",
          },
        },
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "林夏",
        sequence: 1,
      },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(storylineService.saveRewrittenSegment).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      segmentId: "3",
      instruction: "文风更加轻快。",
      generatedText: "林夏轻快地推开钟楼木门。",
      model: "rewrite-model",
      elapsedMs: 42,
      usage: {
        inputTokens: 7,
        outputTokens: 8,
        totalTokens: 15,
      },
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("streams dialogue chunks, updates context and saves a dialogue segment", async () => {
    const abortController = new AbortController();
    const previousContext = createContextSnapshot();
    const writerContext = {
      input: "方源让程溪拿奶茶。",
      currentSceneText: "章节正文：\n程溪站在厨房门口。",
      contextBundle: createContextBundle(previousContext),
    };
    const completedStoryline = createCompletedStoryline({
      latestGenerationMode: "dialogue",
      latestText: '程溪白了他一眼，"你自己没长手啊。"',
    });

    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildDialogueLlmContext.mockResolvedValue({
      storyline: {
        id: 10,
        externalId: "10",
        userId: 1,
      },
      previousContext,
      writerContext,
      contextHistoryRounds: [],
      initialStoryText: "方源窝在沙发上。",
    });
    storyService.streamDialogueStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "chunk",
          delta: "程溪",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: '程溪白了他一眼，"你自己没长手啊。"',
          model: "dialogue-model",
          elapsedMs: 18,
          usage: {
            inputTokens: 4,
            outputTokens: 5,
            totalTokens: 9,
          },
        },
      ]),
    );
    storylineService.saveDialogueSegmentWithoutContextUpdate.mockResolvedValue(
      completedStoryline,
    );

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "dialogue",
            storylineId: "10",
            input: "方源让程溪拿奶茶。",
          },
        },
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "程溪",
        sequence: 1,
      },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(
      storylineService.saveDialogueSegmentWithoutContextUpdate,
    ).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      input: "方源让程溪拿奶茶。",
      generatedText: '程溪白了他一眼，"你自己没长手啊。"',
      model: "dialogue-model",
      elapsedMs: 18,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      previousContext,
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("saves no-op dialogue without updating context", async () => {
    const previousContext = createContextSnapshot();
    const writerContext = {
      input: "方源看向门外。",
      currentSceneText: "章节正文：\n客厅里空荡荡的。",
      contextBundle: createContextBundle(previousContext),
    };
    const completedStoryline = createCompletedStoryline({
      latestGenerationMode: "dialogue",
      latestText: "无事发生",
    });

    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildDialogueLlmContext.mockResolvedValue({
      storyline: {
        id: 10,
        externalId: "10",
        userId: 1,
      },
      previousContext,
      writerContext,
      contextHistoryRounds: [],
    });
    storyService.streamDialogueStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "chunk",
          delta: "无事发生",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: "无事发生",
          model: "dialogue-model",
          elapsedMs: 5,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ]),
    );
    storylineService.saveDialogueSegmentWithoutContextUpdate.mockResolvedValue(
      completedStoryline,
    );

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "dialogue",
            storylineId: "10",
            input: "方源看向门外。",
          },
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "无事发生",
        sequence: 1,
      },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(contextExtractionService.extractNextBatch).not.toHaveBeenCalled();
    expect(
      storylineService.saveDialogueSegmentWithoutContextUpdate,
    ).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      input: "方源看向门外。",
      generatedText: "无事发生",
      model: "dialogue-model",
      elapsedMs: 5,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      previousContext,
    });
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

async function* createStoryStream(
  events: readonly StoryStreamEvent[],
): AsyncIterable<StoryStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createCompletedStoryline(input: {
  readonly latestText: string;
  readonly latestGenerationMode?: "append" | "dialogue";
}): CompletedStorylineSnapshot {
  return {
    id: "10",
    segments: [
      { id: "1", type: "initial", text: "雨停以后。" },
      {
        id: "2",
        type: "generated",
        generationMode: "append",
        text: "林夏走向钟楼。",
      },
      {
        id: "3",
        type: "generated",
        generationMode: input.latestGenerationMode ?? "append",
        text: input.latestText,
      },
    ],
    latestGeneration: {
      segmentId: "3",
      model: "model",
      elapsedMs: 42,
      usage: {
        inputTokens: 7,
        outputTokens: 8,
        totalTokens: 15,
      },
    },
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function createContextSnapshot() {
  return emptyStoryContextSnapshot;
}

function createContextBundle(
  storyContext = emptyStoryContextSnapshot,
): StoryWriterContextBundle {
  return {
    storyContext,
    observableFacts: [],
    activeCharacters: [],
    recentHistoryRounds: [],
    historyWasTrimmed: false,
    contextWasMissing: false,
  };
}
