import { Injectable, Logger } from "@nestjs/common";
import type {
  CancelStoryGenerationResponse,
  StoryGenerationPhase,
  StoryRealtimeErrorCode,
} from "@kimiko/schema";
import {
  getRealtimeErrorMessage,
  mapRealtimeStreamErrorCode,
} from "../realtime/realtime-error.utils";
import { StorylineGenerationService } from "./storyline-generation.service";
import { StoryGenerationTaskRegistry } from "./story-generation-task.registry";
import type {
  CancelByRequestInput,
  CancelByRequestResult,
  CancelByStorylineInput,
  DetachObserverInput,
  GetStorylineTaskStatusInput,
  GetStorylineTaskStatusResult,
  StartStoryGenerationTaskInput,
  StartStoryGenerationTaskResult,
  StoryGenerationTaskRecord,
} from "./story-generation-task.types";
import type { StorylineStreamEvent } from "./storyline.types";

@Injectable()
export class StoryGenerationTaskService {
  private readonly logger = new Logger(StoryGenerationTaskService.name);

  constructor(
    private readonly storylineGenerationService: StorylineGenerationService,
    private readonly registry: StoryGenerationTaskRegistry,
  ) {}

  start(input: StartStoryGenerationTaskInput): StartStoryGenerationTaskResult {
    if (
      isStorylineTaskPayload(input.payload) &&
      this.registry.hasActiveStorylineTask({
        storylineId: input.payload.storylineId,
        userId: input.userId,
      })
    ) {
      return { status: "busy", code: "STORYLINE_BUSY" };
    }

    const startedAt = Date.now();
    const task = this.registry.createTask({
      abortController: new AbortController(),
      observer: input.observer,
      payload: input.payload,
      requestId: input.requestId,
      startedAt,
      userId: input.userId,
    });

    this.logTaskEvent(task, {
      event: "story_generation_task_started",
    });
    task.observer?.sendStarted();
    void this.runTask(task, input);
    return { status: "started", task };
  }

  cancelByRequest(input: CancelByRequestInput): CancelByRequestResult {
    if (
      input.activeRequestId === null ||
      input.activeRequestId !== input.requestId
    ) {
      return { status: "noActiveTask" };
    }

    const task = this.registry.getTaskByRequest({
      requestId: input.requestId,
      userId: input.userId,
    });
    if (task?.status !== "running") {
      return { status: "noActiveTask" };
    }

    const cancelResult = this.registry.cancelTask({
      now: Date.now(),
      task,
    });
    if (!cancelResult.cancelled) {
      return { status: "notCancelled", task };
    }

    task.abortController.abort();
    task.observer?.sendCancelled();
    this.logTaskEvent(task, {
      event: "story_generation_task_cancel_requested",
      reason: "user_cancelled",
    });
    this.logTaskEvent(task, {
      event: "story_generation_task_terminal",
      reason: "user_cancelled",
    });
    return { status: "cancelled", task };
  }

  cancelByStoryline(
    input: CancelByStorylineInput,
  ): CancelStoryGenerationResponse {
    const task = this.registry.getVisibleStorylineTask({
      now: Date.now(),
      storylineId: input.storylineId,
      userId: input.userId,
    });
    if (task === null) {
      return {
        cancelled: false,
        task: null,
      };
    }

    const cancelResult = this.registry.cancelTask({
      now: Date.now(),
      task,
    });
    if (!cancelResult.cancelled) {
      return cancelResult.response;
    }

    task.abortController.abort();
    task.observer?.sendCancelled();
    this.logTaskEvent(task, {
      event: "story_generation_task_cancel_requested",
      reason: "user_cancelled",
    });
    this.logTaskEvent(task, {
      event: "story_generation_task_terminal",
      reason: "user_cancelled",
    });
    return cancelResult.response;
  }

  detachObserver(input: DetachObserverInput): void {
    const task = this.registry.detachObserver({
      requestId: input.requestId,
      userId: input.userId,
    });
    if (task === null) {
      return;
    }

    this.logTaskEvent(task, {
      closeCode: input.closeCode,
      closeReason: input.closeReason,
      event: "story_generation_task_observer_detached",
    });
  }

  getStorylineTaskStatus(
    input: GetStorylineTaskStatusInput,
  ): GetStorylineTaskStatusResult {
    return this.registry.getStorylineStatus({
      now: Date.now(),
      storylineId: input.storylineId,
      userId: input.userId,
    });
  }

  private async runTask(
    task: StoryGenerationTaskRecord,
    input: StartStoryGenerationTaskInput,
  ): Promise<void> {
    let terminalEvent: StorylineStreamEvent["type"] | null = null;

    try {
      for await (const event of this.storylineGenerationService.streamContinueStoryline(
        {
          requestId: input.requestId,
          userId: input.userId,
          payload: input.payload,
        },
        {
          signal: task.abortController.signal,
          onPhaseChange: (phaseEvent) => {
            this.updatePhase(task, phaseEvent.phase);
          },
        },
      )) {
        if (
          task.status === "cancelled" ||
          task.abortController.signal.aborted
        ) {
          return;
        }

        this.forwardStreamEvent(task, event);
        if (event.type !== "chunk" && event.type !== "reasoning") {
          terminalEvent = event.type;
        }

        if (event.type === "completed") {
          this.registry.completeTask(task, {
            generatedSegmentId: event.generatedSegmentId,
            now: Date.now(),
          });
          this.logTaskEvent(task, {
            event: "story_generation_task_terminal",
          });
        }
      }

      if (
        task.status === "running" &&
        !task.abortController.signal.aborted &&
        terminalEvent !== "completed"
      ) {
        this.failRunningTask(task, "GENERATION_FAILED");
      }
    } catch (error: unknown) {
      if (task.status === "cancelled" || task.abortController.signal.aborted) {
        return;
      }

      const errorCode = mapRealtimeStreamErrorCode(error);
      this.failRunningTask(task, errorCode, error);
    } finally {
      if (task.mode === "create" && task.status !== "running") {
        this.registry.deleteTask(task);
      }
    }
  }

  private forwardStreamEvent(
    task: StoryGenerationTaskRecord,
    event: StorylineStreamEvent,
  ): void {
    if (event.type === "reasoning") {
      task.observer?.sendReasoning(event);
      return;
    }

    if (event.type === "chunk") {
      task.observer?.sendChunk(event);
      return;
    }

    if (event.type === "contextStarted") {
      task.observer?.sendContextStarted();
      return;
    }

    if (event.type === "contextFailed") {
      task.observer?.sendContextFailed(event.message);
      return;
    }

    task.observer?.sendCompleted(event);
  }

  private updatePhase(
    task: StoryGenerationTaskRecord,
    phase: StoryGenerationPhase,
  ): void {
    const wasUpdated = this.registry.updatePhase(task, phase);
    if (!wasUpdated) {
      return;
    }

    this.logTaskEvent(task, {
      event: "story_generation_task_phase_changed",
    });
  }

  private failRunningTask(
    task: StoryGenerationTaskRecord,
    code: StoryRealtimeErrorCode,
    error?: unknown,
  ): void {
    const message = getRealtimeErrorMessage(code);
    const wasUpdated = this.registry.failTask(task, {
      code,
      message,
      now: Date.now(),
    });
    if (!wasUpdated) {
      return;
    }

    task.observer?.sendError({
      code,
      message,
      retryable: true,
    });
    this.logTaskEvent(task, {
      error,
      event: "story_generation_task_terminal",
    });
  }

  private logTaskEvent(
    task: StoryGenerationTaskRecord,
    input: Readonly<{
      closeCode?: number | undefined;
      closeReason?: string | undefined;
      error?: unknown;
      event:
        | "story_generation_task_started"
        | "story_generation_task_phase_changed"
        | "story_generation_task_observer_detached"
        | "story_generation_task_cancel_requested"
        | "story_generation_task_terminal";
      reason?: string | undefined;
    }>,
  ): void {
    const payload = {
      closeCode: input.closeCode,
      closeReason: input.closeReason,
      elapsedMs: Math.max(0, Date.now() - task.startedAt),
      error:
        input.error === undefined ? undefined : toLoggableError(input.error),
      errorCode: task.errorCode,
      event: input.event,
      generatedSegmentId: task.generatedSegmentId,
      hadObserver: task.observer !== null,
      mode: task.mode,
      phase: task.status === "running" ? task.phase : undefined,
      reason: input.reason,
      requestId: task.requestId,
      status: task.status,
      storylineId: task.storylineId,
      userId: task.userId,
    };

    if (
      input.event === "story_generation_task_terminal" &&
      task.status === "failed"
    ) {
      this.logger.error(JSON.stringify(payload));
      return;
    }

    this.logger.log(JSON.stringify(payload));
  }
}

function isStorylineTaskPayload(
  payload: StartStoryGenerationTaskInput["payload"],
): payload is Extract<
  StartStoryGenerationTaskInput["payload"],
  { storylineId: string }
> {
  return payload.mode !== "create" && payload.mode !== "createFromSetting";
}

function toLoggableError(error: unknown): Readonly<{
  message: string;
  name: string;
  stack?: string;
}> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
