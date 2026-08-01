import type {
  StoryChapterChatStreamEvent,
  StoryContextSnapshot,
} from "@kimiko/schema";
import type { StorylineRecord } from "./storyline.types";

export interface StoryChatSegmentMaterial {
  readonly kind: "initial" | "append" | "dialogue";
  readonly text: string;
}

export interface StoryChatChapterMaterial {
  readonly chapterNumber: number;
  readonly isCurrent: boolean;
  readonly segments: readonly StoryChatSegmentMaterial[];
}

export interface StoryChapterChatContext {
  readonly storyline: StorylineRecord;
  readonly currentChapterNumber: number;
  readonly startChapterNumber: number;
  readonly endChapterNumber: number;
  readonly storyContext: StoryContextSnapshot | null;
  readonly contextExtractedThroughOrderIndex: number;
  readonly chapters: readonly StoryChatChapterMaterial[];
}

export interface PreparedStoryChatSession {
  readonly chapterNumber: number;
  readonly requestId: string;
  release(): void;
  stream(options: {
    readonly signal: AbortSignal;
  }): AsyncIterable<StoryChapterChatStreamEvent>;
}
