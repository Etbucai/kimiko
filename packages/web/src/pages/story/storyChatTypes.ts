export type StoryChatEntryStatus =
  | "connecting"
  | "thinking"
  | "answering"
  | "completed"
  | "cancelled"
  | "failed";

export interface StoryChatEntry {
  readonly id: string;
  readonly chapterNumber: number;
  readonly topic: string;
  readonly reasoningText: string;
  readonly answerText: string;
  readonly status: StoryChatEntryStatus;
  readonly isExpanded: boolean;
  readonly isReasoningExpanded: boolean;
  readonly errorMessage?: string | undefined;
}

export type StoryChatsByChapter = Readonly<
  Record<number, readonly StoryChatEntry[]>
>;

export type StoryChatDraftsByChapter = Readonly<Record<number, string>>;

export interface ActiveStoryChat {
  readonly chatId: string;
  readonly chapterNumber: number;
}

export function appendStoryChat(
  state: StoryChatsByChapter,
  entry: StoryChatEntry,
): StoryChatsByChapter {
  return {
    ...state,
    [entry.chapterNumber]: [...(state[entry.chapterNumber] ?? []), entry],
  };
}

export function updateStoryChat(
  state: StoryChatsByChapter,
  chapterNumber: number,
  chatId: string,
  updater: (entry: StoryChatEntry) => StoryChatEntry,
): StoryChatsByChapter {
  const entries = state[chapterNumber];
  if (entries === undefined) {
    return state;
  }

  const targetIndex = entries.findIndex((entry) => entry.id === chatId);
  if (targetIndex < 0) {
    return state;
  }

  return {
    ...state,
    [chapterNumber]: entries.map((entry, index) =>
      index === targetIndex ? updater(entry) : entry,
    ),
  };
}

export function hasStoryChatDrafts(drafts: StoryChatDraftsByChapter): boolean {
  return Object.values(drafts).some((draft) => draft.trim().length > 0);
}
