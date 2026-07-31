import { Injectable, Logger } from "@nestjs/common";
import type {
  StoryContextExtractionTask,
  StoryContextExtractionTaskResponse,
} from "@kimiko/schema";
import { StorylineContextExtractionService } from "./storyline-context-extraction.service";
import { StorylineBusyError } from "./storyline.errors";
import { StorylineLockService } from "./storyline-lock.service";

interface StoryContextExtractionTaskRecord {
  message: string | null;
  pendingRoundCount: number;
  processedRoundCount: number;
  status: StoryContextExtractionTask["status"];
  totalRoundCount: number;
}

@Injectable()
export class StoryContextExtractionTaskService {
  private readonly logger = new Logger(StoryContextExtractionTaskService.name);
  private readonly tasks = new Map<string, StoryContextExtractionTaskRecord>();

  constructor(
    private readonly extractionService: StorylineContextExtractionService,
    private readonly lockService: StorylineLockService,
  ) {}

  async start(input: {
    readonly userId: string;
    readonly storylineId: string;
  }): Promise<StoryContextExtractionTaskResponse> {
    const key = getTaskKey(input);
    if (this.tasks.get(key)?.status === "running") {
      throw new StorylineBusyError();
    }

    const state = await this.extractionService.getState(
      input.userId,
      input.storylineId,
    );
    if (state.pendingRoundCount === 0) {
      const task: StoryContextExtractionTaskRecord = {
        message: null,
        pendingRoundCount: 0,
        processedRoundCount: 0,
        status: "completed",
        totalRoundCount: 0,
      };
      this.tasks.set(key, task);
      return { task: toTaskDto(task) };
    }

    const releaseLock = this.lockService.acquireStorylineLock(
      input.storylineId,
    );
    const task: StoryContextExtractionTaskRecord = {
      message: null,
      pendingRoundCount: state.pendingRoundCount,
      processedRoundCount: 0,
      status: "running",
      totalRoundCount: state.pendingRoundCount,
    };
    this.tasks.set(key, task);
    this.logger.log(
      JSON.stringify({
        event: "story_context_extraction_task_started",
        storylineId: input.storylineId,
        totalRoundCount: task.totalRoundCount,
        userId: input.userId,
      }),
    );
    void this.runTask(task, input, releaseLock);
    return { task: toTaskDto(task) };
  }

  getStatus(input: {
    readonly userId: string;
    readonly storylineId: string;
  }): StoryContextExtractionTaskResponse {
    const task = this.tasks.get(getTaskKey(input));
    return { task: task === undefined ? null : toTaskDto(task) };
  }

  private async runTask(
    task: StoryContextExtractionTaskRecord,
    input: Readonly<{ userId: string; storylineId: string }>,
    releaseLock: () => void,
  ): Promise<void> {
    try {
      while (task.pendingRoundCount > 0) {
        const result = await this.extractionService.extractNextBatch({
          userId: input.userId,
          storylineId: input.storylineId,
          signal: new AbortController().signal,
        });
        if (result.extractedRoundCount === 0) {
          break;
        }

        task.processedRoundCount += result.extractedRoundCount;
        task.pendingRoundCount = result.pendingRoundCount;
      }

      task.status = "completed";
      task.message = null;
    } catch (error: unknown) {
      task.status = "failed";
      task.message = getTaskErrorMessage(error);
    } finally {
      releaseLock();
      this.logger.log(
        JSON.stringify({
          event: "story_context_extraction_task_terminal",
          message: task.message,
          pendingRoundCount: task.pendingRoundCount,
          processedRoundCount: task.processedRoundCount,
          status: task.status,
          storylineId: input.storylineId,
          totalRoundCount: task.totalRoundCount,
          userId: input.userId,
        }),
      );
    }
  }
}

function getTaskKey(input: {
  readonly userId: string;
  readonly storylineId: string;
}): string {
  return `${input.userId}:${input.storylineId}`;
}

function toTaskDto(
  task: StoryContextExtractionTaskRecord,
): StoryContextExtractionTask {
  return {
    status: task.status,
    processedRoundCount: task.processedRoundCount,
    totalRoundCount: task.totalRoundCount,
    pendingRoundCount: task.pendingRoundCount,
    message: task.message,
  };
}

function getTaskErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "上下文提取失败，请稍后重试";
}
