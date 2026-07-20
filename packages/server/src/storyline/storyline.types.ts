import type {
  CompletedStorylineSnapshot,
  ContinueStoryUsage,
  StoryContinuePayload,
} from "@kimiko/schema";

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

export interface SaveAppendedSegmentInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
}

export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;

export interface ContinueStorylineInput {
  readonly userId: string;
  readonly payload: StoryContinuePayload;
}
