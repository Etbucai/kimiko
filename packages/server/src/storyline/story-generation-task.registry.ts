import { Injectable } from "@nestjs/common";
import type {
  StoryContinuePayload,
  StoryGenerationPhase,
  StoryGenerationStatusResponse,
  StoryGenerationTask,
} from "@kimiko/schema";
import type {
  CancelTaskStateResult,
  CompleteTaskInput,
  FailTaskInput,
  StoryGenerationObserver,
  StoryGenerationTaskKey,
  StoryGenerationTaskRecord,
} from "./story-generation-task.types";

const terminalTaskTtlMs = 10 * 60 * 1000;

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
      cleanupTimer: null,
      errorCode: null,
      expiresAt: null,
      generatedSegmentId: null,
      key,
      message: null,
      mode: input.payload.mode,
      observer: input.observer,
      phase: "preparing",
      requestId: input.requestId,
      startedAt: input.startedAt,
      status: "running",
      storylineId: getStorylineIdFromPayload(input.payload),
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

    if (input.task.phase === "saving") {
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
    task.status = "failed";
    this.markTerminal(task, input.now);
    return true;
  }

  detachObserver(input: {
    readonly requestId: string;
    readonly userId: string;
  }): StoryGenerationTaskRecord | null {
    const task = this.getTaskByRequest(input);
    if (task === null) {
      return null;
    }

    task.observer = null;
    return task;
  }

  deleteTask(task: StoryGenerationTaskRecord): void {
    clearTaskCleanupTimer(task);
    this.tasks.delete(task.key);
  }

  toResponseTask(task: StoryGenerationTaskRecord): StoryGenerationTask {
    return toStoryGenerationTask(task);
  }

  private markCancelled(task: StoryGenerationTaskRecord, now: number): void {
    task.status = "cancelled";
    this.markTerminal(task, now);
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
  if (input.payload.mode === "create") {
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
  return payload.mode === "create" ? null : payload.storylineId;
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
