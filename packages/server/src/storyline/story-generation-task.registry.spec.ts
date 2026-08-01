import type { StoryContinuePayload } from "@kimiko/schema";
import { StoryGenerationTaskRegistry } from "./story-generation-task.registry";
import type { StoryGenerationObserver } from "./story-generation-task.types";

describe("StoryGenerationTaskRegistry", () => {
  let registry: StoryGenerationTaskRegistry;
  let observer: StoryGenerationObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new StoryGenerationTaskRegistry();
    observer = createObserver("request-1");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("registers an active storyline task and updates phases", () => {
    const task = registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });

    expect(
      registry.getStorylineStatus({
        now: 1000,
        storylineId: "10",
        userId: "user-1",
      }),
    ).toEqual({
      task: {
        status: "running",
        phase: "preparing",
        mode: "append",
        requestId: "request-1",
        storylineId: "10",
      },
    });

    expect(registry.updatePhase(task, "streaming")).toBe(true);
    expect(registry.updatePhase(task, "streaming")).toBe(false);
    expect(
      registry.getStorylineStatus({
        now: 1000,
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "running",
      phase: "streaming",
    });
  });

  it("returns true when the same storyline has an active task", () => {
    registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });

    expect(
      registry.hasActiveStorylineTask({
        storylineId: "10",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("cancels active tasks before saving", () => {
    const task = registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });
    registry.updatePhase(task, "streaming");

    const result = registry.cancelTask({
      now: 2000,
      task,
    });

    expect(result.response).toEqual({
      cancelled: true,
      task: {
        status: "cancelled",
        mode: "append",
        requestId: "request-1",
        storylineId: "10",
      },
    });
    expect(task.status).toBe("cancelled");
  });

  it("does not cancel a task that already entered saving", () => {
    const task = registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });
    registry.updatePhase(task, "saving");

    const result = registry.cancelTask({
      now: 2000,
      task,
    });
    registry.completeTask(task, {
      generatedSegmentId: "3",
      now: 3000,
    });

    expect(result.cancelled).toBe(false);
    expect(task.status).toBe("completed");
    expect(
      registry.getStorylineStatus({
        now: 3000,
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "completed",
      generatedSegmentId: "3",
    });
  });

  it("keeps terminal storyline tasks for ten minutes then lazily expires them", () => {
    const task = registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });

    registry.completeTask(task, {
      generatedSegmentId: "3",
      now: 2000,
    });

    expect(
      registry.getStorylineStatus({
        now: 2000 + 10 * 60 * 1000 - 1,
        storylineId: "10",
        userId: "user-1",
      }).task,
    ).toMatchObject({
      status: "completed",
      generatedSegmentId: "3",
    });
    expect(
      registry.getStorylineStatus({
        now: 2000 + 10 * 60 * 1000,
        storylineId: "10",
        userId: "user-1",
      }),
    ).toEqual({ task: null });
  });

  it("overwrites a terminal task when a new task starts for the same storyline", () => {
    const firstTask = registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: createAppendPayload("10"),
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });
    registry.completeTask(firstTask, {
      generatedSegmentId: "3",
      now: 2000,
    });

    registry.createTask({
      abortController: new AbortController(),
      observer: createObserver("request-2"),
      payload: createAppendPayload("10"),
      requestId: "request-2",
      startedAt: 3000,
      userId: "user-1",
    });

    expect(
      registry.getStorylineStatus({
        now: 3000,
        storylineId: "10",
        userId: "user-1",
      }),
    ).toEqual({
      task: {
        status: "running",
        phase: "preparing",
        mode: "append",
        requestId: "request-2",
        storylineId: "10",
      },
    });
  });

  it("does not expose create tasks through storyline status", () => {
    registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: {
        mode: "create",
        initialStoryText: "开场。",
        instruction: "继续。",
      },
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });

    expect(
      registry.getStorylineStatus({
        now: 1000,
        storylineId: "10",
        userId: "user-1",
      }),
    ).toEqual({ task: null });
  });

  it("does not expose create-from-setting tasks through storyline status", () => {
    registry.createTask({
      abortController: new AbortController(),
      observer,
      payload: {
        mode: "createFromSetting",
        settingId: "5",
        opening: "从雨夜开始。",
      },
      requestId: "request-1",
      startedAt: 1000,
      userId: "user-1",
    });

    expect(
      registry.getStorylineStatus({
        now: 1000,
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

function createObserver(requestId: string): StoryGenerationObserver {
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
