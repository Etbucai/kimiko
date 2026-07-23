import type { StorylineSegment, StorylineSegmentId } from "@kimiko/schema";

export function getLatestGeneratedSegmentId(
  segments: readonly StorylineSegment[],
): StorylineSegmentId | null {
  const latestGeneratedSegment = [...segments]
    .reverse()
    .find((segment) => segment.type === "generated");

  return latestGeneratedSegment?.id ?? null;
}
