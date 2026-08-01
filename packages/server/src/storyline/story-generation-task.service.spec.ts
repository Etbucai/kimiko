import type {
  CompletedStorylineSnapshot,
  StoryContinuePayload,
  StoryGenerationPhase,
} from "@kimiko/schema";
import type { StorylineGenerationService } from "./storyline-generation.service";
import { StoryGenerationTaskRegistry } from "./story-generation-task.registry";
import { StoryGenerationTaskService } from "./story-generation-task.service";
import type { StoryGenerationObserver } from "./story-generation-task.types";
import type {
  StorylineGenerationOptions,
  StorylineStreamEvent,
} from "./storyline.types";

describe("StoryGenerationTaskService", () => {
  let generationService: jest.Mocked<
    Pick<StorylineGenerationService, "streamContinueStoryline">
  >;
  let registry: StoryGenerationTaskRegistry;
  let taskService: StoryGenerationTaskService;
  let observer: jest.Mocked<StoryGenerationObserver>;

  beforeEach(() => {
    jest.useFakeTimers();
    generationService = {
      streamContinueStoryline: jest.fn(),
    };
    registry = new StoryGenerationTaskRegistry();
    taskService = new StoryGenerationTaskService(
      generationService as unknown as StorylineGenerationService,
      registry,
    );
    observer = createObserver("request-1");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts a task, sends realtime events and stores completed terminal state", async () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createStorylineStream([
        { type: "reasoning", delta: "先衔接场景。", sequence: 1 },
        { type: "chunk", delta: "林夏", sequence: 1 },
        { type: "contextStarted" },
        { type: "contextFailed", message: "上下文提取失败" },
        {
          type: "completed",
          generatedSegmentId: "3",
          storyline: createCompletedStoryline("3"),
        },
      ]),
    );

    const result = taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });
    await flushPromises();

    expect(result.status).toBe("started");
    expect(observer.sendStarted).toHaveBeenCalledTimes(1);
    expect(observer.sendReasoning).toHaveBeenCalledWith({
      type: "reasoning",
      delta: "先衔接场景。",
      sequence: 1,
    });
    expect(observer.sendChunk).toHaveBeenCalledWith({
      type: "chunk",
      delta: "林夏",
      sequence: 1,
    });
    expect(observer.sendContextStarted).toHaveBeenCalledTimes(1);
    expect(observer.sendContextFailed).toHaveBeenCalledWith("上下文提取失败");
    expect(observer.sendCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "completed",
        generatedSegmentId: "3",
      }),
    );
    expect(
      taskService.getStorylineTaskStatus({
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "completed",
      generatedSegmentId: "3",
    });
  });

  it("rejects a second active task for the same storyline", () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createNeverEndingStorylineStream(),
    );

    taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });
    const secondResult = taskService.start({
      observer: createObserver("request-2"),
      payload: createAppendPayload("10"),
      requestId: "request-2",
      userId: "user-1",
    });

    expect(secondResult).toEqual({
      status: "busy",
      code: "STORYLINE_BUSY",
    });
  });

  it("updates task phase through generation callbacks", async () => {
    generationService.streamContinueStoryline.mockImplementation(
      (_input, options) =>
        createPhaseOnlyStream(options, [
          "streaming",
          "updatingContext",
          "saving",
        ]),
    );

    taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });
    await flushPromises();

    expect(
      taskService.getStorylineTaskStatus({
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "running",
      phase: "saving",
    });
  });

  it("cancels by request id and notifies the observer", () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createNeverEndingStorylineStream(),
    );

    taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });
    const cancelResult = taskService.cancelByRequest({
      activeRequestId: "request-1",
      requestId: "request-1",
      userId: "user-1",
    });

    expect(cancelResult.status).toBe("cancelled");
    expect(observer.sendCancelled).toHaveBeenCalledTimes(1);
    expect(
      taskService.getStorylineTaskStatus({
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not cancel by request when the active request mismatches", () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createNeverEndingStorylineStream(),
    );

    taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });

    expect(
      taskService.cancelByRequest({
        activeRequestId: "request-2",
        requestId: "request-1",
        userId: "user-1",
      }),
    ).toEqual({ status: "noActiveTask" });
  });

  it("cancels a background storyline task by storyline id", () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createNeverEndingStorylineStream(),
    );

    taskService.start({
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      userId: "user-1",
    });
    taskService.detachObserver({
      requestId: "request-1",
      userId: "user-1",
    });
    const response = taskService.cancelByStoryline({
      storylineId: "10",
      userId: "user-1",
    });

    expect(response).toEqual({
      cancelled: true,
      task: {
        status: "cancelled",
        mode: "append",
        requestId: "request-1",
        storylineId: "10",
      },
    });
    expect(observer.sendCancelled).not.toHaveBeenCalled();
  });

  it("does not expose create tasks through storyline status", () => {
    generationService.streamContinueStoryline.mockReturnValue(
      createNeverEndingStorylineStream(),
    );

    taskService.start({
      observer,
      payload: {
        mode: "create",
        initialStoryText: "开场。",
        instruction: "继续。",
      },
      requestId: "request-1",
      userId: "user-1",
    });

    expect(
      taskService.getStorylineTaskStatus({
        storylineId: "10",
        userId: "user-1",
      }),
    ).toEqual({ task: null });
  });
});

function createAppendPayload(storylineId: string): StoryContinuePayload {
  return {
    mode: "append",
    storylineId,
    instruction: "继续。",
    targetLength: 1000,
  };
}

function createObserver(
  requestId: string,
): jest.Mocked<StoryGenerationObserver> {
  return {
    requestId,
    sendStarted: jest.fn(),
    sendReasoning: jest.fn(),
    sendChunk: jest.fn(),
    sendContextStarted: jest.fn(),
    sendContextFailed: jest.fn(),
    sendCompleted: jest.fn(),
    sendCancelled: jest.fn(),
    sendError: jest.fn(),
  };
}

async function* createStorylineStream(
  events: readonly StorylineStreamEvent[],
): AsyncIterable<StorylineStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createNeverEndingStorylineStream(): AsyncIterable<StorylineStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* [];
      await new Promise(() => undefined);
    },
  };
}

function createPhaseOnlyStream(
  options: StorylineGenerationOptions,
  phases: readonly StoryGenerationPhase[],
): AsyncIterable<StorylineStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const phase of phases) {
        options.onPhaseChange?.({ phase });
      }
      yield* [];
      await new Promise(() => undefined);
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createCompletedStoryline(
  segmentId: string,
): CompletedStorylineSnapshot {
  return {
    anchorPage: 1,
    chapterCount: 1,
    chapters: [
      {
        pageNumber: 1,
        segments: [
          {
            id: segmentId,
            type: "generated",
            generationMode: "append",
            text: "正文",
          },
        ],
      },
    ],
    id: "10",
    latestGeneration: {
      segmentId,
      model: "story-model",
      elapsedMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    },
    updatedAt: new Date(0).toISOString(),
  };
}
