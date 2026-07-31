import { Injectable, Logger } from "@nestjs/common";
import type { StoryContextOperation } from "./storyline-context.types";
import type { StoryContextSourceRefMapping } from "./storyline-context.types";
import { StorylineContextService } from "./storyline-context.service";
import {
  STORY_CONTEXT_AUTO_TRIGGER_ROUND_COUNT,
  type StoryContextExtractionBatch,
  type StoryContextExtractionBatchResult,
  type StoryContextExtractionState,
} from "./storyline-context-extraction.types";
import { StorylineService } from "./storyline.service";

@Injectable()
export class StorylineContextExtractionService {
  private readonly logger = new Logger(StorylineContextExtractionService.name);

  constructor(
    private readonly storylineService: StorylineService,
    private readonly storylineContextService: StorylineContextService,
  ) {}

  getState(
    userId: string,
    storylineId: string,
  ): Promise<StoryContextExtractionState> {
    return this.storylineService.getStoryContextExtractionState(
      userId,
      storylineId,
    );
  }

  async extractNextBatch(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly signal: AbortSignal;
  }): Promise<StoryContextExtractionBatchResult> {
    const batch = await this.storylineService.getStoryContextExtractionBatch({
      userId: input.userId,
      storylineId: input.storylineId,
      maxRoundCount: STORY_CONTEXT_AUTO_TRIGGER_ROUND_COUNT,
    });
    if (batch === null) {
      const state = await this.getState(input.userId, input.storylineId);
      return {
        extractedRoundCount: 0,
        pendingRoundCount: state.pendingRoundCount,
      };
    }

    const lastRound = batch.rounds.at(-1);
    if (lastRound === undefined) {
      throw new Error("Story context extraction batch is empty");
    }
    this.logger.log(
      JSON.stringify({
        batchRoundCount: batch.rounds.length,
        event: "story_context_extraction_started",
        fromOrderIndex: batch.rounds[0].orderIndex,
        storylineId: input.storylineId,
        toOrderIndex: lastRound.orderIndex,
        userId: input.userId,
      }),
    );

    const contextPatch =
      await this.storylineContextService.generateStoryContextPatch(
        {
          operation: getBatchOperation(batch),
          previousContext: batch.previousContext,
          sourceRefMappings: buildBatchSourceRefMappings(batch),
          initialStoryText: batch.initialStoryText,
          recentHistoryRounds: batch.rounds.slice(0, -1),
          currentInstruction: lastRound.instruction,
          generatedText: lastRound.generatedText,
        },
        { signal: input.signal },
      );
    await this.storylineService.applyStoryContextExtractionBatch({
      userId: input.userId,
      storylineId: input.storylineId,
      batch,
      contextPatch,
    });
    const state = await this.getState(input.userId, input.storylineId);
    this.logger.log(
      JSON.stringify({
        batchRoundCount: batch.rounds.length,
        event: "story_context_extraction_completed",
        pendingRoundCount: state.pendingRoundCount,
        storylineId: input.storylineId,
        userId: input.userId,
      }),
    );

    return {
      extractedRoundCount: batch.rounds.length,
      pendingRoundCount: state.pendingRoundCount,
    };
  }
}

function getBatchOperation(
  batch: StoryContextExtractionBatch,
): StoryContextOperation {
  const lastRound = batch.rounds.at(-1);
  if (lastRound === undefined) {
    return "append";
  }

  return lastRound.generationMode;
}

function buildBatchSourceRefMappings(
  batch: StoryContextExtractionBatch,
): StoryContextSourceRefMapping[] {
  const lastRound = batch.rounds.at(-1);
  const mappings: StoryContextSourceRefMapping[] = [
    {
      ref: "initial",
      label: "初始故事正文",
      text: batch.initialStoryText,
    },
  ];

  for (const round of batch.rounds.slice(0, -1)) {
    mappings.push({
      ref: `segment:${round.segmentId}`,
      label:
        round.generationMode === "dialogue"
          ? `第 ${round.roundIndex} 轮互动正文`
          : `第 ${round.roundIndex} 轮续写正文`,
      text: round.generatedText,
    });
  }

  if (lastRound !== undefined) {
    mappings.push({
      ref: "current",
      label:
        lastRound.generationMode === "dialogue"
          ? "本批最后一轮互动正文"
          : "本批最后一轮续写正文",
      text: lastRound.generatedText,
    });
  }

  return mappings;
}
