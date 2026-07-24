import { Injectable } from "@nestjs/common";
import { Env } from "../env";
import { StoryService } from "../story/story.service";
import type { StoryHistoryRound, StoryLlmContext } from "../story/story.service";
import {
  StorySegmentNotRewritableError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineContextService } from "./storyline-context.service";
import { emptyStoryContextSnapshot } from "./storyline-context.types";
import type { StoryContextSourceRefMapping } from "./storyline-context.types";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";
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
    private readonly storylineContextService: StorylineContextService,
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
      const writerContext: StoryLlmContext = {
        currentInstruction: input.payload.instruction,
        initialStoryText: input.payload.initialStoryText,
        contextBundle: {
          storyContext: emptyStoryContextSnapshot,
          observableFacts: [],
          activeCharacters: [],
          recentHistoryRounds: [],
          historyWasTrimmed: false,
          contextWasMissing: true,
        },
      };

      for await (const event of this.storyService.streamContinueStoryFromContext(
        writerContext,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          yield event;
          continue;
        }

        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        const contextDraft =
          await this.storylineContextService.generateStoryContextDraft(
            {
              operation: "create",
              previousContext: null,
              sourceRefMappings: [
                {
                  ref: "initial",
                  label: "初始故事正文",
                  text: input.payload.initialStoryText,
                },
                {
                  ref: "current",
                  label: "本轮生成正文",
                  text: event.continuedStory,
                },
              ],
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
          await this.storylineService.saveCreatedStorylineWithContext({
            userId: input.userId,
            initialStoryText: input.payload.initialStoryText,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            contextDraft,
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
      const previousContext = context.contextBundle.storyContext;

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

        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        const contextDraft =
          await this.storylineContextService.generateStoryContextDraft(
            {
              operation: "append",
              previousContext,
              sourceRefMappings: buildSourceRefMappings({
                initialStoryText: context.initialStoryText,
                recentHistoryRounds: context.contextBundle.recentHistoryRounds,
                currentLabel: "本轮生成正文",
                generatedText: event.continuedStory,
              }),
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.contextBundle.recentHistoryRounds,
              currentInstruction: input.payload.instruction,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveAppendedSegmentWithContext({
            userId: input.userId,
            storylineId: storyline.externalId,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousContext,
            contextDraft,
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

        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        const contextDraft =
          await this.storylineContextService.generateStoryContextDraft(
            {
              operation: "rewrite",
              previousContext: context.previousContext,
              sourceRefMappings: buildSourceRefMappings({
                initialStoryText: context.initialStoryText,
                recentHistoryRounds: context.contextHistoryRounds,
                currentLabel: "重写后的目标段正文",
                generatedText: event.continuedStory,
              }),
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.contextHistoryRounds,
              currentInstruction: input.payload.instruction,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveRewrittenSegmentWithContext({
            userId: input.userId,
            storylineId: storyline.externalId,
            segmentId: context.targetSegmentId,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousContext: context.previousContext,
            contextDraft,
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
            await this.storylineService.saveDialogueSegmentWithoutContextUpdate(
              {
                userId: input.userId,
                storylineId: storyline.externalId,
                input: input.payload.input,
                generatedText: event.continuedStory,
                model: event.model,
                elapsedMs: event.elapsedMs,
                usage: event.usage,
                previousContext: context.previousContext,
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

        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        const contextDraft =
          await this.storylineContextService.generateStoryContextDraft(
            {
              operation: "dialogue",
              previousContext: context.previousContext,
              sourceRefMappings: buildSourceRefMappings({
                initialStoryText: context.initialStoryText,
                recentHistoryRounds: context.contextHistoryRounds,
                currentLabel: "本轮互动正文",
                generatedText: event.continuedStory,
              }),
              ...(context.initialStoryText !== undefined
                ? { initialStoryText: context.initialStoryText }
                : {}),
              recentHistoryRounds: context.contextHistoryRounds,
              currentInstruction: input.payload.input,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }

        const savedStoryline =
          await this.storylineService.saveDialogueSegmentWithContext({
            userId: input.userId,
            storylineId: storyline.externalId,
            input: input.payload.input,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousContext: context.previousContext,
            contextDraft,
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

function buildSourceRefMappings(input: {
  readonly initialStoryText: string | undefined;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentLabel: string;
  readonly generatedText: string;
}): StoryContextSourceRefMapping[] {
  const mappings: StoryContextSourceRefMapping[] = [];
  if (input.initialStoryText !== undefined) {
    mappings.push({
      ref: "initial",
      label: "初始故事正文",
      text: input.initialStoryText,
    });
  }

  for (const round of input.recentHistoryRounds) {
    mappings.push({
      ref: `segment:${round.segmentId}`,
      label:
        round.generationMode === "dialogue"
          ? `第 ${round.roundIndex} 轮互动正文`
          : `第 ${round.roundIndex} 轮续写正文`,
      text: round.generatedText,
    });
  }

  mappings.push({
    ref: "current",
    label: input.currentLabel,
    text: input.generatedText,
  });

  return mappings;
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
