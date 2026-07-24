import type { CompletedStorylineSnapshot } from "@kimiko/schema";
import type {
  StoryService,
  StoryStreamEvent,
  StoryWriterContextBundle,
} from "../story/story.service";
import type { StorylineContextService } from "./storyline-context.service";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";
import { emptyStoryContextSnapshot } from "./storyline-context.types";
import type { StorylineLockService } from "./storyline-lock.service";
import type { StorylineService } from "./storyline.service";
import { StorylineGenerationService } from "./storyline-generation.service";

describe("StorylineGenerationService", () => {
  let storylineService: jest.Mocked<
    Pick<
      StorylineService,
      | "getStorylineForUser"
      | "buildLlmContext"
      | "buildDialogueLlmContext"
      | "buildRewriteLlmContext"
      | "saveAppendedSegmentWithContext"
      | "saveDialogueSegmentWithContext"
      | "saveDialogueSegmentWithoutContextUpdate"
      | "saveRewrittenSegmentWithContext"
    >
  >;
  let storyService: jest.Mocked<
    Pick<
      StoryService,
      | "streamContinueStoryFromContext"
      | "streamDialogueStoryFromContext"
      | "streamRewriteDialogueFromContext"
      | "streamRewriteStoryFromContext"
    >
  >;
  let lockService: jest.Mocked<
    Pick<StorylineLockService, "acquireStorylineLock">
  >;
  let contextService: jest.Mocked<
    Pick<StorylineContextService, "generateStoryContextPatch">
  >;
  let releaseLock: jest.Mock;
  let generationService: StorylineGenerationService;

  beforeEach(() => {
    storylineService = {
      getStorylineForUser: jest.fn(),
      buildLlmContext: jest.fn(),
      buildDialogueLlmContext: jest.fn(),
      buildRewriteLlmContext: jest.fn(),
      saveAppendedSegmentWithContext: jest.fn(),
      saveDialogueSegmentWithContext: jest.fn(),
      saveDialogueSegmentWithoutContextUpdate: jest.fn(),
      saveRewrittenSegmentWithContext: jest.fn(),
    };
    storyService = {
      streamContinueStoryFromContext: jest.fn(),
      streamDialogueStoryFromContext: jest.fn(),
      streamRewriteDialogueFromContext: jest.fn(),
      streamRewriteStoryFromContext: jest.fn(),
    };
    releaseLock = jest.fn();
    lockService = {
      acquireStorylineLock: jest.fn((_storylineId: string) => releaseLock),
    };
    contextService = {
      generateStoryContextPatch: jest.fn(),
    };
    generationService = new StorylineGenerationService(
      storylineService as unknown as StorylineService,
      storyService as unknown as StoryService,
      lockService as unknown as StorylineLockService,
      contextService as unknown as StorylineContextService,
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
    const contextPatch = createContextDraft();
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
    contextService.generateStoryContextPatch.mockResolvedValue(contextPatch);
    storylineService.saveAppendedSegmentWithContext.mockResolvedValue(
      completedStoryline,
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
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
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
    expect(contextService.generateStoryContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "append",
        previousContext,
        currentInstruction: "进入钟楼。",
        generatedText: "林夏推开钟楼木门。",
      }),
      { signal: abortController.signal },
    );
    expect(
      storylineService.saveAppendedSegmentWithContext,
    ).toHaveBeenCalledWith({
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
      previousContext,
      contextPatch,
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
    const contextPatch = createContextDraft();
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
    contextService.generateStoryContextPatch.mockResolvedValue(contextPatch);
    storylineService.saveRewrittenSegmentWithContext.mockResolvedValue(
      completedStoryline,
    );

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
      { type: "contextStarted" },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(contextService.generateStoryContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "rewrite",
        previousContext,
        currentInstruction: "文风更加轻快。",
        generatedText: "林夏轻快地推开钟楼木门。",
      }),
      { signal: abortController.signal },
    );
    expect(
      storylineService.saveRewrittenSegmentWithContext,
    ).toHaveBeenCalledWith({
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
      previousContext,
      contextPatch,
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
    const contextPatch = createContextDraft();
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
    contextService.generateStoryContextPatch.mockResolvedValue(contextPatch);
    storylineService.saveDialogueSegmentWithContext.mockResolvedValue(
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
      { type: "contextStarted" },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(contextService.generateStoryContextPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "dialogue",
        previousContext,
        currentInstruction: "方源让程溪拿奶茶。",
        generatedText: '程溪白了他一眼，"你自己没长手啊。"',
      }),
      { signal: abortController.signal },
    );
    expect(
      storylineService.saveDialogueSegmentWithContext,
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
      contextPatch,
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
    expect(contextService.generateStoryContextPatch).not.toHaveBeenCalled();
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

function createContextDraft(): StoryContextPatchDraft {
  return {
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [],
      update: [],
      resolve: [],
    },
    characters: {
      add: [],
      update: [],
    },
    currentScene: {},
  };
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
