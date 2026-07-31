import type { StoryContextSnapshot } from "@kimiko/schema";
import type { StoryHistoryRound } from "../story/story.service";

export const STORY_CONTEXT_AUTO_TRIGGER_ROUND_COUNT = 10;

export interface StoryContextExtractionRound extends StoryHistoryRound {
  readonly orderIndex: number;
}

export interface StoryContextExtractionBatch {
  readonly expectedExtractedThroughOrderIndex: number;
  readonly initialSegmentId: string;
  readonly initialStoryText: string;
  readonly previousContext: StoryContextSnapshot | null;
  readonly rounds: readonly [
    StoryContextExtractionRound,
    ...StoryContextExtractionRound[],
  ];
}

export interface StoryContextExtractionState {
  readonly context: StoryContextSnapshot | null;
  readonly extractedThroughOrderIndex: number;
  readonly pendingRoundCount: number;
}

export interface StoryContextExtractionBatchResult {
  readonly extractedRoundCount: number;
  readonly pendingRoundCount: number;
}
