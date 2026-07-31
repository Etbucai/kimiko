import { Injectable, Logger } from "@nestjs/common";
import type { StoryGenerationPhase, StoryTargetLength } from "@kimiko/schema";
import { Env } from "../env";
import { StoryService } from "../story/story.service";
import type {
  StoryHistoryRound,
  StoryLlmContext,
} from "../story/story.service";
import {
  StorySegmentNotRewritableError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorySettingService } from "./story-setting.service";
import { StorylineContextService } from "./storyline-context.service";
import { emptyStoryContextSnapshot } from "./storyline-context.types";
import type { StoryContextSourceRefMapping } from "./storyline-context.types";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";
import type {
  ContinueStorylineInput,
  HistoryScoreConfig,
  StorylineGenerationOptions,
  StorylineStreamEvent,
} from "./storyline.types";

const noOpDialogueText = "无事发生";

@Injectable()
export class StorylineGenerationService {
  private readonly logger = new Logger(StorylineGenerationService.name);

  constructor(
    private readonly storylineService: StorylineService,
    private readonly storyService: StoryService,
    private readonly storySettingService: StorySettingService,
    private readonly storylineLockService: StorylineLockService,
    private readonly storylineContextService: StorylineContextService,
  ) {}

  async *streamContinueStoryline(
    input: ContinueStorylineInput,
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    emitPhase(options, "preparing");
    this.logGenerationPhase({
      mode: input.payload.mode,
      phase: "request_received",
      requestId: input.requestId,
      requestUserId: input.userId,
      settingId: getSettingIdFromPayload(input.payload),
      storylineId: getStorylineIdFromPayload(input.payload),
      targetLength: getTargetLengthFromPayload(input.payload),
    });

    if (input.payload.mode === "create") {
      yield* this.streamCreateStoryline(input, options);
      return;
    }

    if (input.payload.mode === "createFromSetting") {
      yield* this.streamCreateFromSettingStoryline(input, options);
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
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "create") {
      throw new StorylineNotFoundError("Expected create payload");
    }

    const startedAt = Date.now();
    const releaseLock = this.storylineLockService.acquireCreateLock(
      input.userId,
    );
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "create",
      phase: "lock_acquired",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: null,
    });

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
      let chunkChars = 0;
      let chunkCount = 0;

      emitPhase(options, "streaming");
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "create",
        phase: "writer_stream_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: null,
      });

      for await (const event of this.storyService.streamContinueStoryFromContext(
        writerContext,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logGenerationPhase({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              mode: "create",
              phase: "writer_first_chunk",
              requestId: input.requestId,
              requestUserId: input.userId,
              storylineId: null,
            });
          }
          yield event;
          continue;
        }

        this.logGenerationPhase({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          generatedTextChars: event.continuedStory.length,
          mode: "create",
          phase: "writer_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: null,
        });
        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        emitPhase(options, "updatingContext");
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "create",
          phase: "context_started",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: null,
        });
        const contextPatch =
          await this.storylineContextService.generateStoryContextPatch(
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
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "create",
          phase: "context_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: null,
        });

        emitPhase(options, "saving");
        const storyline =
          await this.storylineService.saveCreatedStorylineWithContext({
            userId: input.userId,
            initialStoryText: input.payload.initialStoryText,
            instruction: input.payload.instruction,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            contextPatch,
          });
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          generatedSegmentId: storyline.latestGeneration.segmentId,
          mode: "create",
          phase: "save_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.id,
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

  private async *streamCreateFromSettingStoryline(
    input: ContinueStorylineInput,
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "createFromSetting") {
      throw new StorylineNotFoundError("Expected createFromSetting payload");
    }

    const startedAt = Date.now();
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "createFromSetting",
      phase: "setting_lookup_started",
      requestId: input.requestId,
      requestUserId: input.userId,
      settingId: input.payload.settingId,
      storylineId: null,
    });
    const setting = await this.storySettingService.getRequiredSettingForUser({
      userId: input.userId,
      settingId: input.payload.settingId,
    });
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "createFromSetting",
      phase: "setting_lookup_completed",
      requestId: input.requestId,
      requestUserId: input.userId,
      settingId: setting.id,
      storylineId: null,
    });

    const releaseLock = this.storylineLockService.acquireCreateLock(
      input.userId,
    );
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "createFromSetting",
      phase: "lock_acquired",
      requestId: input.requestId,
      requestUserId: input.userId,
      settingId: setting.id,
      storylineId: null,
    });

    try {
      const initialStoryText = buildCreateFromSettingInitialText({
        settingContent: setting.content,
        opening: input.payload.opening,
      });
      let chunkChars = 0;
      let chunkCount = 0;

      emitPhase(options, "streaming");
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "createFromSetting",
        phase: "writer_stream_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        settingId: setting.id,
        storylineId: null,
      });

      for await (const event of this.storyService.streamCreateStoryFromSetting(
        {
          settingContent: setting.content,
          opening: input.payload.opening,
        },
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logGenerationPhase({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              mode: "createFromSetting",
              phase: "writer_first_chunk",
              requestId: input.requestId,
              requestUserId: input.userId,
              settingId: setting.id,
              storylineId: null,
            });
          }
          yield event;
          continue;
        }

        this.logGenerationPhase({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          generatedTextChars: event.continuedStory.length,
          mode: "createFromSetting",
          phase: "writer_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          settingId: setting.id,
          storylineId: null,
        });
        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        emitPhase(options, "updatingContext");
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "createFromSetting",
          phase: "context_started",
          requestId: input.requestId,
          requestUserId: input.userId,
          settingId: setting.id,
          storylineId: null,
        });
        const contextPatch =
          await this.storylineContextService.generateStoryContextPatch(
            {
              operation: "create",
              previousContext: null,
              sourceRefMappings: [
                {
                  ref: "initial",
                  label: "设定与开场",
                  text: initialStoryText,
                },
                {
                  ref: "current",
                  label: "本轮生成正文",
                  text: event.continuedStory,
                },
              ],
              initialStoryText,
              recentHistoryRounds: [],
              currentInstruction: input.payload.opening,
              generatedText: event.continuedStory,
            },
            options,
          );
        if (options.signal.aborted) {
          return;
        }
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "createFromSetting",
          phase: "context_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          settingId: setting.id,
          storylineId: null,
        });

        emitPhase(options, "saving");
        const storyline =
          await this.storylineService.saveCreatedStorylineWithContext({
            userId: input.userId,
            initialStoryText,
            instruction: input.payload.opening,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            contextPatch,
          });
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          generatedSegmentId: storyline.latestGeneration.segmentId,
          mode: "createFromSetting",
          phase: "save_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          settingId: setting.id,
          storylineId: storyline.id,
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
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "append") {
      throw new StorylineNotFoundError("Expected append payload");
    }

    const appendTargetLength = input.payload.targetLength;
    const startedAt = Date.now();
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "append",
      phase: "storyline_lookup_started",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: input.payload.storylineId,
      targetLength: appendTargetLength,
    });
    const storyline = await this.storylineService.getStorylineForUser(
      input.userId,
      input.payload.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "append",
      phase: "storyline_lookup_completed",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
      targetLength: appendTargetLength,
    });

    const releaseLock = this.storylineLockService.acquireStorylineLock(
      storyline.externalId,
    );
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "append",
      phase: "lock_acquired",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
      targetLength: appendTargetLength,
    });

    try {
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "append",
        phase: "llm_context_build_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
        targetLength: appendTargetLength,
      });
      const context = await this.storylineService.buildLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        currentInstruction: input.payload.instruction,
        targetLength: appendTargetLength,
        historyScoreConfig: getHistoryScoreConfig(),
      });
      const previousContext = context.contextBundle.storyContext;
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "append",
        phase: "llm_context_build_completed",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
        targetLength: appendTargetLength,
      });
      let chunkChars = 0;
      let chunkCount = 0;

      emitPhase(options, "streaming");
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "append",
        phase: "writer_stream_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
        targetLength: appendTargetLength,
      });

      for await (const event of this.storyService.streamContinueStoryFromContext(
        context,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logGenerationPhase({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              mode: "append",
              phase: "writer_first_chunk",
              requestId: input.requestId,
              requestUserId: input.userId,
              storylineId: storyline.externalId,
              targetLength: appendTargetLength,
            });
          }
          yield event;
          continue;
        }

        this.logGenerationPhase({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          generatedTextChars: event.continuedStory.length,
          mode: "append",
          phase: "writer_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: appendTargetLength,
        });
        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        emitPhase(options, "updatingContext");
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "append",
          phase: "context_started",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: appendTargetLength,
        });
        const contextPatch =
          await this.storylineContextService.generateStoryContextPatch(
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
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "append",
          phase: "context_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: appendTargetLength,
        });

        emitPhase(options, "saving");
        const savedStoryline =
          await this.storylineService.saveAppendedSegmentWithContext({
            userId: input.userId,
            storylineId: storyline.externalId,
            instruction: input.payload.instruction,
            targetLength: appendTargetLength,
            generatedText: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
            previousContext,
            contextPatch,
          });
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          generatedSegmentId: savedStoryline.latestGeneration.segmentId,
          mode: "append",
          phase: "save_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: appendTargetLength,
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
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "rewrite") {
      throw new StorySegmentNotRewritableError("Expected rewrite payload");
    }

    const startedAt = Date.now();
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "rewrite",
      phase: "storyline_lookup_started",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: input.payload.storylineId,
    });
    const storyline = await this.storylineService.getStorylineForUser(
      input.userId,
      input.payload.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "rewrite",
      phase: "storyline_lookup_completed",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
    });

    const releaseLock = this.storylineLockService.acquireStorylineLock(
      storyline.externalId,
    );
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "rewrite",
      phase: "lock_acquired",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
    });

    try {
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "rewrite",
        phase: "llm_context_build_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
      });
      const context = await this.storylineService.buildRewriteLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        segmentId: input.payload.segmentId,
        rewriteInstruction: input.payload.instruction,
        historyScoreConfig: getHistoryScoreConfig(),
      });
      const rewriteTargetLength =
        context.targetGenerationMode === "append"
          ? context.writerContext.targetLength
          : undefined;
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "rewrite",
        phase: "llm_context_build_completed",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
        targetLength: rewriteTargetLength,
        targetGenerationMode: context.targetGenerationMode,
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
      let chunkChars = 0;
      let chunkCount = 0;

      emitPhase(options, "streaming");
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "rewrite",
        phase: "writer_stream_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
        targetLength: rewriteTargetLength,
        targetGenerationMode: context.targetGenerationMode,
      });

      for await (const event of rewriteStream) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logGenerationPhase({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              mode: "rewrite",
              phase: "writer_first_chunk",
              requestId: input.requestId,
              requestUserId: input.userId,
              storylineId: storyline.externalId,
              targetLength: rewriteTargetLength,
              targetGenerationMode: context.targetGenerationMode,
            });
          }
          yield event;
          continue;
        }

        this.logGenerationPhase({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          generatedTextChars: event.continuedStory.length,
          mode: "rewrite",
          phase: "writer_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: rewriteTargetLength,
          targetGenerationMode: context.targetGenerationMode,
        });
        yield { type: "contextStarted" };
        if (options.signal.aborted) {
          return;
        }

        emitPhase(options, "updatingContext");
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "rewrite",
          phase: "context_started",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: rewriteTargetLength,
          targetGenerationMode: context.targetGenerationMode,
        });
        const contextPatch =
          await this.storylineContextService.generateStoryContextPatch(
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
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "rewrite",
          phase: "context_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: rewriteTargetLength,
          targetGenerationMode: context.targetGenerationMode,
        });

        emitPhase(options, "saving");
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
            contextPatch,
          });
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          generatedSegmentId: savedStoryline.latestGeneration.segmentId,
          mode: "rewrite",
          phase: "save_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
          targetLength: rewriteTargetLength,
          targetGenerationMode: context.targetGenerationMode,
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
    options: StorylineGenerationOptions,
  ): AsyncIterable<StorylineStreamEvent> {
    if (input.payload.mode !== "dialogue") {
      throw new StorylineNotFoundError("Expected dialogue payload");
    }

    const startedAt = Date.now();
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "dialogue",
      phase: "storyline_lookup_started",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: input.payload.storylineId,
    });
    const storyline = await this.storylineService.getStorylineForUser(
      input.userId,
      input.payload.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "dialogue",
      phase: "storyline_lookup_completed",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
    });

    const releaseLock = this.storylineLockService.acquireStorylineLock(
      storyline.externalId,
    );
    this.logGenerationPhase({
      elapsedMs: getElapsedMs(startedAt),
      mode: "dialogue",
      phase: "lock_acquired",
      requestId: input.requestId,
      requestUserId: input.userId,
      storylineId: storyline.externalId,
    });

    try {
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "dialogue",
        phase: "llm_context_build_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
      });
      const context = await this.storylineService.buildDialogueLlmContext({
        userId: input.userId,
        storylineId: storyline.externalId,
        input: input.payload.input,
        historyScoreConfig: getHistoryScoreConfig(),
      });
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "dialogue",
        phase: "llm_context_build_completed",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
      });
      let chunkChars = 0;
      let chunkCount = 0;

      emitPhase(options, "streaming");
      this.logGenerationPhase({
        elapsedMs: getElapsedMs(startedAt),
        mode: "dialogue",
        phase: "writer_stream_started",
        requestId: input.requestId,
        requestUserId: input.userId,
        storylineId: storyline.externalId,
      });

      for await (const event of this.storyService.streamDialogueStoryFromContext(
        context.writerContext,
        options,
      )) {
        if (options.signal.aborted) {
          return;
        }

        if (event.type === "chunk") {
          chunkCount += 1;
          chunkChars += event.delta.length;
          if (chunkCount === 1) {
            this.logGenerationPhase({
              chunkChars,
              chunkCount,
              elapsedMs: getElapsedMs(startedAt),
              mode: "dialogue",
              phase: "writer_first_chunk",
              requestId: input.requestId,
              requestUserId: input.userId,
              storylineId: storyline.externalId,
            });
          }
          yield event;
          continue;
        }

        this.logGenerationPhase({
          chunkChars,
          chunkCount,
          elapsedMs: getElapsedMs(startedAt),
          generatedTextChars: event.continuedStory.length,
          mode: "dialogue",
          phase: "writer_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
        });
        if (isNoOpDialogueText(event.continuedStory)) {
          emitPhase(options, "saving");
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
          this.logGenerationPhase({
            elapsedMs: getElapsedMs(startedAt),
            generatedSegmentId: savedStoryline.latestGeneration.segmentId,
            mode: "dialogue",
            phase: "noop_save_completed",
            requestId: input.requestId,
            requestUserId: input.userId,
            storylineId: storyline.externalId,
          });

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

        emitPhase(options, "updatingContext");
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "dialogue",
          phase: "context_started",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
        });
        const contextPatch =
          await this.storylineContextService.generateStoryContextPatch(
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
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          mode: "dialogue",
          phase: "context_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
        });

        emitPhase(options, "saving");
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
            contextPatch,
          });
        this.logGenerationPhase({
          elapsedMs: getElapsedMs(startedAt),
          generatedSegmentId: savedStoryline.latestGeneration.segmentId,
          mode: "dialogue",
          phase: "save_completed",
          requestId: input.requestId,
          requestUserId: input.userId,
          storylineId: storyline.externalId,
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

  private logGenerationPhase(
    input: Readonly<{
      chunkChars?: number | undefined;
      chunkCount?: number | undefined;
      elapsedMs?: number | undefined;
      generatedSegmentId?: string;
      generatedTextChars?: number | undefined;
      mode: ContinueStorylineInput["payload"]["mode"];
      phase:
        | "request_received"
        | "setting_lookup_started"
        | "setting_lookup_completed"
        | "storyline_lookup_started"
        | "storyline_lookup_completed"
        | "lock_acquired"
        | "llm_context_build_started"
        | "llm_context_build_completed"
        | "writer_stream_started"
        | "writer_first_chunk"
        | "writer_completed"
        | "context_started"
        | "context_completed"
        | "save_completed"
        | "noop_save_completed";
      requestId?: string | undefined;
      requestUserId: string;
      settingId?: string | undefined;
      storylineId: string | null;
      targetLength?: StoryTargetLength | undefined;
      targetGenerationMode?: string | undefined;
    }>,
  ): void {
    this.logger.log(
      JSON.stringify({
        chunkChars: input.chunkChars,
        chunkCount: input.chunkCount,
        elapsedMs: input.elapsedMs,
        event: "story_generation_phase",
        generatedSegmentId: input.generatedSegmentId,
        generatedTextChars: input.generatedTextChars,
        mode: input.mode,
        phase: input.phase,
        requestId: input.requestId,
        settingId: input.settingId,
        storylineId: input.storylineId,
        targetLength: input.targetLength,
        targetGenerationMode: input.targetGenerationMode,
        userId: input.requestUserId,
      }),
    );
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

function getStorylineIdFromPayload(
  payload: ContinueStorylineInput["payload"],
): string | null {
  return payload.mode === "create" || payload.mode === "createFromSetting"
    ? null
    : payload.storylineId;
}

function getSettingIdFromPayload(
  payload: ContinueStorylineInput["payload"],
): string | undefined {
  return payload.mode === "createFromSetting" ? payload.settingId : undefined;
}

function getTargetLengthFromPayload(
  payload: ContinueStorylineInput["payload"],
): StoryTargetLength | undefined {
  return payload.mode === "append" ? payload.targetLength : undefined;
}

function isNoOpDialogueText(value: string): boolean {
  return value.trim() === noOpDialogueText;
}

function getElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function emitPhase(
  options: StorylineGenerationOptions,
  phase: StoryGenerationPhase,
): void {
  options.onPhaseChange?.({ phase });
}

export function buildCreateFromSettingInitialText(input: {
  readonly opening: string;
  readonly settingContent: string;
}): string {
  return [
    "【设定】",
    input.settingContent.trim(),
    "",
    "【开场】",
    input.opening.trim(),
  ].join("\n");
}
