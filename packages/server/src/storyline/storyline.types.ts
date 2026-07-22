import type {
  CompletedStorylineSnapshot,
  ContinueStoryUsage,
  StoryContinuePayload,
} from "@kimiko/schema";
import type { StoryCharacterSummarySnapshot } from "./storyline-summary.types";

export interface StorylineRecord {
  readonly id: number;
  readonly externalId: string;
  readonly userId: number;
}

export interface SaveCreatedStorylineInput {
  readonly userId: string;
  readonly initialStoryText: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
}

export interface SaveCreatedStorylineWithSummaryInput
  extends SaveCreatedStorylineInput {
  readonly characterSummary: StoryCharacterSummarySnapshot;
}

export interface SaveAppendedSegmentInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
}

export interface SaveAppendedSegmentWithSummaryInput
  extends SaveAppendedSegmentInput {
  readonly characterSummary: StoryCharacterSummarySnapshot;
}

export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{ type: "summaryStarted" }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;

export interface ContinueStorylineInput {
  readonly userId: string;
  readonly payload: StoryContinuePayload;
}
