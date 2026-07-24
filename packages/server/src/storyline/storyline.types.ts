import type {
  CompletedStorylineSnapshot,
  ContinueStoryUsage,
  StoryContextSnapshot,
  StoryContinuePayload,
  StoryGenerationPhase,
  StorylineGenerationMode,
} from "@kimiko/schema";
import type {
  StoryDialogueLlmContext,
  StoryDialogueRewriteLlmContext,
  StoryHistoryRound,
  StoryRewriteLlmContext,
} from "../story/story.service";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";

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

export interface SaveCreatedStorylineWithContextInput extends SaveCreatedStorylineInput {
  readonly contextPatch: StoryContextPatchDraft;
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

export interface SaveAppendedSegmentWithContextInput extends SaveAppendedSegmentInput {
  readonly previousContext: StoryContextSnapshot;
  readonly contextPatch: StoryContextPatchDraft;
}

export interface SaveRewrittenSegmentWithContextInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly segmentId: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly previousContext: StoryContextSnapshot;
  readonly contextPatch: StoryContextPatchDraft;
}

export interface SaveDialogueSegmentInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly input: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly previousContext: StoryContextSnapshot;
}

export interface SaveDialogueSegmentWithContextInput extends SaveDialogueSegmentInput {
  readonly contextPatch: StoryContextPatchDraft;
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
  readonly previousContext: StoryContextSnapshot;
  readonly contextHistoryRounds: readonly StoryHistoryRound[];
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
  readonly previousContext: StoryContextSnapshot;
  readonly writerContext: StoryDialogueLlmContext;
  readonly contextHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
}

export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{ type: "contextStarted" }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;

export interface ContinueStorylineInput {
  readonly requestId?: string;
  readonly userId: string;
  readonly payload: StoryContinuePayload;
}

export interface StorylineGenerationPhaseEvent {
  readonly phase: StoryGenerationPhase;
}

export interface StorylineGenerationOptions {
  readonly onPhaseChange?: (event: StorylineGenerationPhaseEvent) => void;
  readonly signal: AbortSignal;
}
