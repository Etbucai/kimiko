import type { StoryCharacterSummarySnapshot } from "@kimiko/schema";
import {
  StoryCharacterSummarySchema,
  StoryCharacterSummarySnapshotSchema,
} from "@kimiko/schema";
import type { StoryHistoryRound } from "../story/story.service";

export { StoryCharacterSummarySchema, StoryCharacterSummarySnapshotSchema };
export type { StoryCharacterSummarySnapshot };

export type StorySummaryOperation = "append" | "rewrite" | "dialogue";

export interface GenerateCharacterSummaryInput {
  readonly operation: StorySummaryOperation;
  readonly previousSummary: StoryCharacterSummarySnapshot | null;
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}

export const emptyCharacterSummarySnapshot: StoryCharacterSummarySnapshot = {
  characters: [],
};
