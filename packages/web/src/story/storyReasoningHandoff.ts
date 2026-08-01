import type { StorylineId } from "@kimiko/schema";

interface StoryReasoningHandoff {
  readonly reasoningText: string;
  readonly storylineId: StorylineId;
}

let pendingHandoff: StoryReasoningHandoff | null = null;

export function setStoryReasoningHandoff(
  handoff: StoryReasoningHandoff,
): void {
  pendingHandoff =
    handoff.reasoningText.length > 0
      ? {
          reasoningText: handoff.reasoningText,
          storylineId: handoff.storylineId,
        }
      : null;
}

export function readStoryReasoningHandoff(
  storylineId: StorylineId,
): string {
  return pendingHandoff?.storylineId === storylineId
    ? pendingHandoff.reasoningText
    : "";
}

export function clearStoryReasoningHandoff(storylineId: StorylineId): void {
  if (pendingHandoff?.storylineId === storylineId) {
    pendingHandoff = null;
  }
}
