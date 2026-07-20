import { Injectable } from "@nestjs/common";
import { Env } from "../env";
import { StoryService } from "../story/story.service";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";
import type {
  ContinueStorylineInput,
  StorylineStreamEvent,
} from "./storyline.types";
import { StorylineNotFoundError } from "./storyline.errors";

@Injectable()
export class StorylineGenerationService {
  constructor(
    private readonly storylineService: StorylineService,
    private readonly storyService: StoryService,
    private readonly storylineLockService: StorylineLockService,
  ) {}

  async *streamContinueStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode === "create") {
      yield* this.streamCreateStoryline(input, options);
      return;
    }

    yield* this.streamAppendStoryline(input, options);
  }

  private async *streamCreateStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "create") {
      throw new StorylineNotFoundError("Expected create payload");
    }

    const releaseLock = this.storylineLockService.acquireCreateLock(
      input.userId,
    );

    try {
      for await (const event of this.storyService.streamContinueStoryFromContext(
        {
          currentInstruction: input.payload.instruction,
          initialStoryText: input.payload.initialStoryText,
          historyRounds: [],
          historyWasTrimmed: false,
        },
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          yield event;
          continue;
        }

        const storyline = await this.storylineService.saveCreatedStoryline({
          userId: input.userId,
          initialStoryText: input.payload.initialStoryText,
          instruction: input.payload.instruction,
          generatedText: event.continuedStory,
          model: event.model,
          elapsedMs: event.elapsedMs,
          usage: event.usage,
        });

        yield {
          type: "completed",
          storyline,
          generatedSegmentId: storyline.latestGeneration.segmentId,
        };
      }
    } finally {
      releaseLock();
    }
  }

  private async *streamAppendStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "append") {
      throw new StorylineNotFoundError("Expected append payload");
    }

    const storyline = await this.storylineService.getStorylineForUser(
      input.userId,
      input.payload.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }

    const releaseLock = this.storylineLockService.acquireStorylineLock(
      storyline.externalId,
    );

    try {
      const context = await this.storylineService.buildLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        currentInstruction: input.payload.instruction,
        historyRoundLimit: Env.story.historyRoundLimit,
      });

      for await (const event of this.storyService.streamContinueStoryFromContext(
        context,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          yield event;
          continue;
        }

        const savedStoryline = await this.storylineService.saveAppendedSegment({
          userId: input.userId,
          storylineId: storyline.externalId,
          instruction: input.payload.instruction,
          generatedText: event.continuedStory,
          model: event.model,
          elapsedMs: event.elapsedMs,
          usage: event.usage,
        });

        yield {
          type: "completed",
          storyline: savedStoryline,
          generatedSegmentId: savedStoryline.latestGeneration.segmentId,
        };
      }
    } finally {
      releaseLock();
    }
  }
}
