import { Injectable } from "@nestjs/common";
import type {
  StoryContinuePayload,
  StoryGenerationPhase,
  StoryGenerationRecoveryResponse,
  StoryGenerationStatusResponse,
  StoryGenerationStreamSnapshot,
  StoryGenerationTask,
} from "@kimiko/schema";
import type {
  AttachObserverResult,
  CancelTaskStateResult,
  CompleteTaskInput,
  FailTaskInput,
  PersistTaskInput,
  StoryGenerationObserver,
  StoryGenerationTaskKey,
  StoryGenerationTaskRecord,
} from "./story-generation-task.types";
import type { StorylineStreamEvent } from "./storyline.types";

const terminalTaskTtlMs = 10 * 60 * 1000;
export const storyGenerationBufferLimitBytes = 1024 * 1024;

@Injectable()
export class StoryGenerationTaskRegistry {
  private readonly tasks = new Map<
    StoryGenerationTaskKey,
    StoryGenerationTaskRecord
  >();

  createTask(input: {
    readonly abortController: AbortController;
    readonly observer: StoryGenerationObserver;
    readonly payload: StoryContinuePayload;
    readonly requestId: string;
    readonly startedAt: number;
    readonly userId: string;
  }): StoryGenerationTaskRecord {
    const key = getTaskKey({
      payload: input.payload,
      requestId: input.requestId,
      userId: input.userId,
    });
    const previousTask = this.tasks.get(key);
    if (previousTask !== undefined) {
      clearTaskCleanupTimer(previousTask);
      this.tasks.delete(key);
    }

    const task: StoryGenerationTaskRecord = {
      abortController: input.abortController,
      bufferedBytes: 0,
      cleanupTimer: null,
      errorCode: null,
      expiresAt: null,
      generatedSegmentId: null,
      key,
      message: null,
      mode: input.payload.mode,
      observers: new Set([input.observer]),
      outputPersisted: false,
      phase: "preparing",
      reasoningSequence: 0,
      reasoningText: "",
      requestId: input.requestId,
      rewriteTargetSegmentId:
        input.payload.mode === "rewrite" ? input.payload.segmentId : null,
      startedAt: input.startedAt,
      status: "running",
      storylineId: getStorylineIdFromPayload(input.payload),
      streamSequence: 0,
      streamText: "",
      terminalAt: null,
      userId: input.userId,
    };
    this.tasks.set(key, task);
    return task;
  }

  hasActiveStorylineTask(input: {
    readonly storylineId: string;
    readonly userId: string;
  }): boolean {
    const task = this.tasks.get(getStorylineTaskKey(input));
    return task?.status === "running";
  }

  getTaskByRequest(input: {
    readonly requestId: string;
    readonly userId: string;
  }): StoryGenerationTaskRecord | null {
    const task = [...this.tasks.values()].find(
      (taskRecord) =>
        taskRecord.userId === input.userId &&
        taskRecord.requestId === input.requestId,
    );
    if (task !== undefined) {
      return task;
    }

    return null;
  }

  getStorylineStatus(input: {
    readonly storylineId: string;
    readonly now: number;
    readonly userId: string;
  }): StoryGenerationStatusResponse {
    const key = getStorylineTaskKey(input);
    const task = this.tasks.get(key);
    if (task === undefined) {
      return { task: null };
    }

    if (isTerminalTaskExpired(task, input.now)) {
      this.deleteTask(task);
      return { task: null };
    }

    return { task: toStoryGenerationTask(task) };
  }

  getStorylineRecovery(input: {
    readonly storylineId: string;
    readonly now: number;
    readonly userId: string;
  }): StoryGenerationRecoveryResponse {
    const task = this.getVisibleStorylineTask(input);
    if (task === null) {
      return {
        task: null,
        snapshot: null,
        outputPersisted: false,
      };
    }

    return {
      task: toStoryGenerationTask(task),
      snapshot:
        task.status === "running" && !task.outputPersisted
          ? toStreamSnapshot(task)
          : null,
      outputPersisted: task.outputPersisted,
    };
  }

  getVisibleStorylineTask(input: {
    readonly storylineId: string;
    readonly now: number;
    readonly userId: string;
  }): StoryGenerationTaskRecord | null {
    const task = this.tasks.get(getStorylineTaskKey(input));
    if (task === undefined) {
      return null;
    }

    if (isTerminalTaskExpired(task, input.now)) {
      this.deleteTask(task);
      return null;
    }

    return task;
  }

  updatePhase(
    task: StoryGenerationTaskRecord,
    phase: StoryGenerationPhase,
  ): boolean {
    if (task.status !== "running" || task.phase === phase) {
      return false;
    }

    task.phase = phase;
    return true;
  }

  appendStreamEvent(
    task: StoryGenerationTaskRecord,
    event: Extract<StorylineStreamEvent, { type: "chunk" | "reasoning" }>,
  ): boolean {
    if (task.storylineId === null || task.outputPersisted) {
      return true;
    }

    const nextBufferedBytes =
      task.bufferedBytes + Buffer.byteLength(event.delta, "utf8");
    if (nextBufferedBytes > storyGenerationBufferLimitBytes) {
      return false;
    }

    task.bufferedBytes = nextBufferedBytes;
    if (event.type === "chunk") {
      task.streamText += event.delta;
      task.streamSequence = event.sequence;
      return true;
    }

    task.reasoningText += event.delta;
    task.reasoningSequence = event.sequence;
    return true;
  }

  attachObserver(input: {
    readonly observer: StoryGenerationObserver;
    readonly requestId: string;
    readonly storylineId: string;
    readonly userId: string;
  }): AttachObserverResult {
    const task = this.getVisibleStorylineTask({
      now: Date.now(),
      storylineId: input.storylineId,
      userId: input.userId,
    });
    if (task?.requestId !== input.requestId) {
      return { status: "notFound", task };
    }

    if (task.outputPersisted && task.generatedSegmentId !== null) {
      if (task.status === "running") {
        task.observers.add(input.observer);
      }
      return {
        status: "persisted",
        task,
        generatedSegmentId: task.generatedSegmentId,
      };
    }

    if (task.status === "cancelled") {
      return { status: "cancelled", task };
    }

    if (task.status === "failed" || task.status === "completed") {
      return { status: "failed", task };
    }

    task.observers.add(input.observer);
    return {
      status: "attached",
      task,
      snapshot: toStreamSnapshot(task),
    };
  }

  cancelTask(input: {
    readonly now: number;
    readonly task: StoryGenerationTaskRecord;
  }): CancelTaskStateResult {
    if (input.task.status !== "running") {
      return {
        cancelled: false,
        response: {
          cancelled: false,
          task: toStoryGenerationTask(input.task),
        },
        task: input.task,
      };
    }

    if (
      input.task.phase === "saving" ||
      input.task.phase === "updatingContext"
    ) {
      return {
        cancelled: false,
        response: {
          cancelled: false,
          task: toStoryGenerationTask(input.task),
        },
        task: input.task,
      };
    }

    this.markCancelled(input.task, input.now);
    return {
      cancelled: true,
      response: {
        cancelled: true,
        task: toStoryGenerationTask(input.task),
      },
      task: input.task,
    };
  }

  completeTask(
    task: StoryGenerationTaskRecord,
    input: CompleteTaskInput & Readonly<{ now: number }>,
  ): boolean {
    if (task.status === "cancelled") {
      return false;
    }

    task.generatedSegmentId = input.generatedSegmentId;
    this.clearStreamCache(task);
    task.status = "completed";
    this.markTerminal(task, input.now);
    return true;
  }

  failTask(
    task: StoryGenerationTaskRecord,
    input: FailTaskInput & Readonly<{ now: number }>,
  ): boolean {
    if (task.status === "cancelled") {
      return false;
    }

    task.errorCode = input.code;
    task.message = input.message;
    this.clearStreamCache(task);
    task.status = "failed";
    this.markTerminal(task, input.now);
    return true;
  }

  markPersisted(
    task: StoryGenerationTaskRecord,
    input: PersistTaskInput,
  ): boolean {
    if (task.status !== "running" || task.outputPersisted) {
      return false;
    }

    task.generatedSegmentId = input.generatedSegmentId;
    task.outputPersisted = true;
    this.clearStreamCache(task);
    return true;
  }

  detachObserver(input: {
    readonly observerId: string;
    readonly requestId: string;
    readonly userId: string;
  }): StoryGenerationTaskRecord | null {
    const task = this.getTaskByRequest(input);
    if (task === null) {
      return null;
    }

    for (const observer of task.observers) {
      if (observer.observerId === input.observerId) {
        task.observers.delete(observer);
        break;
      }
    }
    return task;
  }

  clearObservers(task: StoryGenerationTaskRecord): void {
    task.observers.clear();
  }

  deleteTask(task: StoryGenerationTaskRecord): void {
    clearTaskCleanupTimer(task);
    this.tasks.delete(task.key);
  }

  toResponseTask(task: StoryGenerationTaskRecord): StoryGenerationTask {
    return toStoryGenerationTask(task);
  }

  private markCancelled(task: StoryGenerationTaskRecord, now: number): void {
    this.clearStreamCache(task);
    task.status = "cancelled";
    this.markTerminal(task, now);
  }

  private clearStreamCache(task: StoryGenerationTaskRecord): void {
    task.bufferedBytes = 0;
    task.reasoningSequence = 0;
    task.reasoningText = "";
    task.streamSequence = 0;
    task.streamText = "";
  }

  private markTerminal(task: StoryGenerationTaskRecord, now: number): void {
    task.terminalAt = now;
    task.expiresAt = now + terminalTaskTtlMs;
    clearTaskCleanupTimer(task);
    if (task.storylineId !== null) {
      task.cleanupTimer = setTimeout(() => {
        const currentTask = this.tasks.get(task.key);
        if (currentTask === task) {
          this.deleteTask(task);
        }
      }, terminalTaskTtlMs);
      task.cleanupTimer.unref();
    }
  }
}

export function getTaskKey(input: {
  readonly payload: StoryContinuePayload;
  readonly requestId: string;
  readonly userId: string;
}): StoryGenerationTaskKey {
  if (
    input.payload.mode === "create" ||
    input.payload.mode === "createFromSetting"
  ) {
    return `create:${input.userId}:${input.requestId}`;
  }

  return getStorylineTaskKey({
    storylineId: input.payload.storylineId,
    userId: input.userId,
  });
}

function getStorylineTaskKey(input: {
  readonly storylineId: string;
  readonly userId: string;
}): StoryGenerationTaskKey {
  return `storyline:${input.userId}:${input.storylineId}`;
}

function getStorylineIdFromPayload(
  payload: StoryContinuePayload,
): string | null {
  return payload.mode === "create" || payload.mode === "createFromSetting"
    ? null
    : payload.storylineId;
}

function toStoryGenerationTask(
  task: StoryGenerationTaskRecord,
): StoryGenerationTask {
  return {
    status: task.status,
    ...(task.status === "running" ? { phase: task.phase } : {}),
    mode: task.mode,
    requestId: task.requestId,
    ...(task.storylineId !== null ? { storylineId: task.storylineId } : {}),
    ...(task.generatedSegmentId !== null
      ? { generatedSegmentId: task.generatedSegmentId }
      : {}),
    ...(task.errorCode !== null ? { errorCode: task.errorCode } : {}),
    ...(task.message !== null ? { message: task.message } : {}),
  };
}

function toStreamSnapshot(
  task: StoryGenerationTaskRecord,
): StoryGenerationStreamSnapshot {
  return {
    text: task.streamText,
    sequence: task.streamSequence,
    reasoningText: task.reasoningText,
    reasoningSequence: task.reasoningSequence,
    ...(task.rewriteTargetSegmentId === null
      ? {}
      : { rewriteTargetSegmentId: task.rewriteTargetSegmentId }),
  };
}

function isTerminalTaskExpired(
  task: StoryGenerationTaskRecord,
  now: number,
): boolean {
  return (
    task.status !== "running" &&
    task.expiresAt !== null &&
    task.expiresAt <= now
  );
}

function clearTaskCleanupTimer(task: StoryGenerationTaskRecord): void {
  if (task.cleanupTimer === null) {
    return;
  }

  clearTimeout(task.cleanupTimer);
  task.cleanupTimer = null;
}
