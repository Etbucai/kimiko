import type {
  CompletedStorylineSnapshot,
  ContinueStoryUsage,
  StoryContinuePayload,
  StorylineGenerationMode,
} from "@kimiko/schema";
import type { StoryCharacterSummarySnapshot } from "./storyline-summary.types";
import type {
  StoryDialogueLlmContext,
  StoryDialogueRewriteLlmContext,
  StoryHistoryRound,
  StoryRewriteLlmContext,
} from "../story/story.service";

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

export interface SaveCreatedStorylineWithSummaryInput extends SaveCreatedStorylineInput {
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

export interface SaveAppendedSegmentWithSummaryInput extends SaveAppendedSegmentInput {
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly characterSummary: StoryCharacterSummarySnapshot;
}

export interface SaveRewrittenSegmentWithSummaryInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly segmentId: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly characterSummary: StoryCharacterSummarySnapshot;
}

export interface SaveDialogueSegmentInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly input: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly previousSummary: StoryCharacterSummarySnapshot;
}

export interface SaveDialogueSegmentWithSummaryInput extends SaveDialogueSegmentInput {
  readonly characterSummary: StoryCharacterSummarySnapshot;
}

export interface HistoryScoreConfig {
  readonly appendScore: number;
  readonly dialogueScore: number;
  readonly scoreLimit: number;
}

interface BaseStorylineRewriteContext {
  readonly storyline: StorylineRecord;
  readonly targetSegmentId: string;
  readonly targetGenerationMode: StorylineGenerationMode;
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly summaryHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
}

export type StorylineRewriteContext =
  | (BaseStorylineRewriteContext &
      Readonly<{
        targetGenerationMode: "append";
        writerContext: StoryRewriteLlmContext;
      }>)
  | (BaseStorylineRewriteContext &
      Readonly<{
        targetGenerationMode: "dialogue";
        writerContext: StoryDialogueRewriteLlmContext;
      }>);

export interface StorylineDialogueContext {
  readonly storyline: StorylineRecord;
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly writerContext: StoryDialogueLlmContext;
  readonly summaryHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
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
