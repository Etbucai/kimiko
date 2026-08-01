import {
  StoryContextSnapshotSchema,
  type StoryContextSnapshot,
} from "@kimiko/schema";
import { StorylineCopyFailedError } from "./storyline.errors";

export function remapStoryContextSegmentIds(input: {
  readonly context: StoryContextSnapshot;
  readonly segmentIdMap: ReadonlyMap<string, string>;
}): StoryContextSnapshot {
  const remapSourceIds = (sourceIds: readonly string[]): string[] =>
    sourceIds.map((sourceId) => {
      const copiedId = input.segmentIdMap.get(sourceId);
      if (copiedId === undefined) {
        throw new StorylineCopyFailedError(
          "Story context references a segment outside the copied prefix",
        );
      }

      return copiedId;
    });

  const remappedContext: StoryContextSnapshot = {
    worldFacts: input.context.worldFacts.map((fact) => ({
      ...fact,
      sourceSegmentIds: remapSourceIds(fact.sourceSegmentIds),
    })),
    characters: input.context.characters.map((character) => ({
      ...character,
      relationships: character.relationships.map((relationship) => ({
        ...relationship,
        sourceSegmentIds: remapSourceIds(relationship.sourceSegmentIds),
      })),
      beliefs: character.beliefs.map((belief) => ({
        ...belief,
        sourceSegmentIds: remapSourceIds(belief.sourceSegmentIds),
      })),
      opinions: character.opinions.map((opinion) => ({
        ...opinion,
        sourceSegmentIds: remapSourceIds(opinion.sourceSegmentIds),
      })),
      sourceSegmentIds: remapSourceIds(character.sourceSegmentIds),
    })),
    currentScene: {
      ...input.context.currentScene,
      sourceSegmentIds: remapSourceIds(
        input.context.currentScene.sourceSegmentIds,
      ),
    },
  };
  const result = StoryContextSnapshotSchema.safeParse(remappedContext);
  if (!result.success) {
    throw new StorylineCopyFailedError(
      result.error.issues[0]?.message ?? "Remapped story context is invalid",
    );
  }

  return result.data;
}
