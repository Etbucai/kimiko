import type { StoryContextSnapshot } from "@kimiko/schema";
import { parseStoryContextJson } from "./storyline-context-normalize";

interface StoryContextRowLike {
  readonly contextJson: string;
  readonly extractedThroughOrderIndex: number;
}

interface StorySegmentRowLike {
  readonly id: number;
  readonly orderIndex: number;
  readonly previousContextJson: string | null;
  readonly previousContextOrderIndex: number | null;
  readonly type: "initial" | "generated";
}

export interface StoryContextSnapshotSelection {
  readonly context: StoryContextSnapshot;
  readonly extractedThroughOrderIndex: number;
}

export class StoryContextSnapshotSelectionError extends Error {
  constructor(message = "Failed to select a safe story context snapshot") {
    super(message);
    this.name = "StoryContextSnapshotSelectionError";
  }
}

export function selectStoryContextSnapshotAtCutoff(input: {
  readonly contextRow: StoryContextRowLike | undefined;
  readonly cutoffOrderIndex: number;
  readonly segments: readonly StorySegmentRowLike[];
}): StoryContextSnapshotSelection | null {
  const contextRow = input.contextRow;
  if (contextRow === undefined || contextRow.extractedThroughOrderIndex === 0) {
    return null;
  }

  const selection =
    contextRow.extractedThroughOrderIndex <= input.cutoffOrderIndex
      ? {
          context: parseContext(contextRow.contextJson),
          extractedThroughOrderIndex: contextRow.extractedThroughOrderIndex,
        }
      : selectPreviousContext({
          contextRow,
          cutoffOrderIndex: input.cutoffOrderIndex,
          segments: input.segments,
        });

  if (selection === null) {
    return null;
  }

  assertContextReferencesPrefix({
    context: selection.context,
    cutoffOrderIndex: input.cutoffOrderIndex,
    segments: input.segments,
  });
  return selection;
}

function selectPreviousContext(input: {
  readonly contextRow: StoryContextRowLike;
  readonly cutoffOrderIndex: number;
  readonly segments: readonly StorySegmentRowLike[];
}): StoryContextSnapshotSelection | null {
  const firstExcludedSegment = input.segments.find(
    (segment) =>
      segment.orderIndex > input.cutoffOrderIndex &&
      segment.type === "generated",
  );
  if (firstExcludedSegment === undefined) {
    throw new StoryContextSnapshotSelectionError(
      "Story context is ahead of the requested cutoff",
    );
  }

  const previousContextOrderIndex =
    firstExcludedSegment.previousContextOrderIndex ?? 0;
  if (
    previousContextOrderIndex === 0 ||
    firstExcludedSegment.previousContextJson === null
  ) {
    return null;
  }

  if (previousContextOrderIndex > input.cutoffOrderIndex) {
    throw new StoryContextSnapshotSelectionError(
      "Previous story context is ahead of the requested cutoff",
    );
  }

  return {
    context: parseContext(firstExcludedSegment.previousContextJson),
    extractedThroughOrderIndex: previousContextOrderIndex,
  };
}

function parseContext(value: string): StoryContextSnapshot {
  try {
    return parseStoryContextJson(value);
  } catch {
    throw new StoryContextSnapshotSelectionError(
      "Story context snapshot is invalid",
    );
  }
}

function assertContextReferencesPrefix(input: {
  readonly context: StoryContextSnapshot;
  readonly cutoffOrderIndex: number;
  readonly segments: readonly StorySegmentRowLike[];
}): void {
  const allowedSegmentIds = new Set(
    input.segments
      .filter((segment) => segment.orderIndex <= input.cutoffOrderIndex)
      .map((segment) => String(segment.id)),
  );
  const sourceSegmentIds = [
    ...input.context.worldFacts.flatMap((fact) => fact.sourceSegmentIds),
    ...input.context.characters.flatMap((character) => [
      ...character.sourceSegmentIds,
      ...character.relationships.flatMap(
        (relationship) => relationship.sourceSegmentIds,
      ),
      ...character.beliefs.flatMap((belief) => belief.sourceSegmentIds),
      ...character.opinions.flatMap((opinion) => opinion.sourceSegmentIds),
    ]),
    ...input.context.currentScene.sourceSegmentIds,
  ];

  if (
    sourceSegmentIds.some((sourceSegmentId) => {
      return !allowedSegmentIds.has(sourceSegmentId);
    })
  ) {
    throw new StoryContextSnapshotSelectionError(
      "Story context references a segment after the requested cutoff",
    );
  }
}
