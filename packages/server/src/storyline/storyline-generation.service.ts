import { Injectable } from "@nestjs/common";
import { Env } from "../env";
import { StoryService } from "../story/story.service";
import {
  StorySegmentNotRewritableError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";
import { StorylineSummaryService } from "./storyline-summary.service";
import { emptyCharacterSummarySnapshot } from "./storyline-summary.types";
import type {
  ContinueStorylineInput,
  HistoryScoreConfig,
  StorylineStreamEvent,
} from "./storyline.types";

const noOpDialogueText = "无事发生";

@Injectable()
export class StorylineGenerationService {
  constructor(
    private readonly storylineService: StorylineService,
    private readonly storyService: StoryService,
    private readonly storylineLockService: StorylineLockService,
    private readonly storylineSummaryService: StorylineSummaryService,
  ) {}

  async *streamContinueStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode === "create") {
      yield* this.streamCreateStoryline(input, options);
      return;
    }

    if (input.payload.mode === "rewrite") {
      yield* this.streamRewriteStoryline(input, options);
      return;
    }

    if (input.payload.mode === "dialogue") {
      yield* this.streamDialogueStoryline(input, options);
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

        yield { type: "summaryStarted" };
        if (options.signal.aborted) {
          return;
        }

        const characterSummary =
          await this.storylineSummaryService.generateCharacterSummary(
            {
              operation: "append",
              previousSummary: null,
              initialStoryText: input.payload.initialStoryText,
              recentHistoryRounds: [],
              currentInstruction: input.payload.instruction,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const storyline =
          await this.storylineService.saveCreatedStorylineWithSummary({
            userId: input.userId,
            initialStoryText: input.payload.initialStoryText,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            characterSummary,
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
        historyScoreConfig: getHistoryScoreConfig(),
      });
      const previousSummary =
        context.characterSummary ?? emptyCharacterSummarySnapshot;

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

        yield { type: "summaryStarted" };
        if (options.signal.aborted) {
          return;
        }

        const characterSummary =
          await this.storylineSummaryService.generateCharacterSummary(
            {
              operation: "append",
              previousSummary,
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.historyRounds,
              currentInstruction: input.payload.instruction,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveAppendedSegmentWithSummary({
            userId: input.userId,
            storylineId: storyline.externalId,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousSummary,
            characterSummary,
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

  private async *streamRewriteStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "rewrite") {
      throw new StorySegmentNotRewritableError("Expected rewrite payload");
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
      const context = await this.storylineService.buildRewriteLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        segmentId: input.payload.segmentId,
        rewriteInstruction: input.payload.instruction,
        historyScoreConfig: getHistoryScoreConfig(),
      });

      const rewriteStream =
        context.targetGenerationMode === "dialogue"
          ? this.storyService.streamRewriteDialogueFromContext(
              context.writerContext,
              options,
            )
          : this.storyService.streamRewriteStoryFromContext(
              context.writerContext,
              options,
            );

      for await (const event of rewriteStream) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          yield event;
          continue;
        }

        yield { type: "summaryStarted" };
        if (options.signal.aborted) {
          return;
        }

        const characterSummary =
          await this.storylineSummaryService.generateCharacterSummary(
            {
              operation: "rewrite",
              previousSummary: context.previousSummary,
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.summaryHistoryRounds,
              currentInstruction: input.payload.instruction,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveRewrittenSegmentWithSummary({
            userId: input.userId,
            storylineId: storyline.externalId,
            segmentId: context.targetSegmentId,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            characterSummary,
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

  private async *streamDialogueStoryline(
    input: ContinueStorylineInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "dialogue") {
      throw new StorylineNotFoundError("Expected dialogue payload");
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
      const context = await this.storylineService.buildDialogueLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        input: input.payload.input,
        historyScoreConfig: getHistoryScoreConfig(),
      });

      for await (const event of this.storyService.streamDialogueStoryFromContext(
        context.writerContext,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          yield event;
          continue;
        }

        if (isNoOpDialogueText(event.continuedStory)) {
          const savedStoryline =
            await this.storylineService.saveDialogueSegmentWithoutSummaryUpdate(
              {
                userId: input.userId,
                storylineId: storyline.externalId,
                input: input.payload.input,
                generatedText: event.continuedStory,
                model: event.model,
                elapsedMs: event.elapsedMs,
                usage: event.usage,
                previousSummary: context.previousSummary,
              },
            );
          if (options.signal.aborted) {
            return;
          }

          yield {
            type: "completed",
            storyline: savedStoryline,
            generatedSegmentId: savedStoryline.latestGeneration.segmentId,
          };
          continue;
        }

        yield { type: "summaryStarted" };
        if (options.signal.aborted) {
          return;
        }

        const characterSummary =
          await this.storylineSummaryService.generateCharacterSummary(
            {
              operation: "dialogue",
              previousSummary: context.previousSummary,
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.summaryHistoryRounds,
              currentInstruction: input.payload.input,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveDialogueSegmentWithSummary({
            userId: input.userId,
            storylineId: storyline.externalId,
            input: input.payload.input,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousSummary: context.previousSummary,
            characterSummary,
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

function getHistoryScoreConfig(): HistoryScoreConfig {
  return {
    appendScore: Env.story.historyAppendScore,
    dialogueScore: Env.story.historyDialogueScore,
    scoreLimit: Env.story.historyScoreLimit,
  };
}

function isNoOpDialogueText(value: string): boolean {
  return value.trim() === noOpDialogueText;
}
