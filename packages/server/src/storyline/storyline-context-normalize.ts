import type {
  StoryCharacterContext,
  StoryContextFactId,
  StoryContextSnapshot,
  StoryWorldFact,
} from "@kimiko/schema";
import { StoryContextSnapshotSchema } from "@kimiko/schema";
import { StoryContextFailedError } from "./storyline.errors";
import {
  emptyStoryContextSnapshot,
  getWorldFactIdentityKey,
  normalizeContextMatchText,
  type NormalizeStoryContextDraftInput,
  type StoryCharacterBeliefDraft,
  type StoryCharacterContextDraft,
  type StoryCharacterRelationshipDraft,
  type StoryContextDraftSnapshot,
  type StoryWorldFactDraft,
} from "./storyline-context.types";

interface IdMappings {
  readonly characterRefToId: ReadonlyMap<string, string>;
  readonly factRefToId: ReadonlyMap<string, StoryContextFactId>;
}

export function normalizeStoryContextDraft(
  input: NormalizeStoryContextDraftInput,
): StoryContextSnapshot {
  const previousContext = input.previousContext ?? emptyStoryContextSnapshot;
  const characterRefToId = buildCharacterRefMappings(
    previousContext,
    input.draftContext,
  );
  const factRefToId = buildFactRefMappings(previousContext, input.draftContext);
  const mappings: IdMappings = { characterRefToId, factRefToId };

  const worldFacts = input.draftContext.worldFacts.map((fact) =>
    normalizeWorldFact(fact, input.sourceRefToSegmentId, factRefToId),
  );
  const characters = input.draftContext.characters.map((character) =>
    normalizeCharacter(character, input.sourceRefToSegmentId, mappings),
  );
  const currentScene = input.draftContext.currentScene;
  const snapshot: StoryContextSnapshot = {
    worldFacts,
    characters,
    currentScene: {
      location: currentScene.location,
      timeLabel: currentScene.timeLabel,
      presentCharacterIds: resolveRefs(
        currentScene.presentCharacterRefs,
        characterRefToId,
        "character",
      ),
      observableFactIds: resolveRefs(
        currentScene.observableFactRefs,
        factRefToId,
        "fact",
      ),
      sceneStatus: currentScene.sceneStatus,
      sourceSegmentIds: mapSourceRefs(
        currentScene.sourceRefs,
        input.sourceRefToSegmentId,
      ),
    },
  };

  const result = StoryContextSnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new StoryContextFailedError(
      firstIssue?.message ?? "Story context schema is invalid",
    );
  }

  return result.data;
}

function buildCharacterRefMappings(
  previousContext: StoryContextSnapshot,
  draftContext: StoryContextDraftSnapshot,
): ReadonlyMap<string, string> {
  const mappings = new Map<string, string>();
  const idByName = new Map<string, string>();

  for (const character of previousContext.characters) {
    mappings.set(character.id, character.id);
    idByName.set(normalizeContextMatchText(character.name), character.id);
    for (const alias of character.aliases) {
      idByName.set(normalizeContextMatchText(alias), character.id);
    }
  }

  let nextIndex = getNextNumericId(
    previousContext.characters.map((character) => character.id),
    "char_",
  );

  for (const character of draftContext.characters) {
    const existingId =
      character.existingId !== undefined &&
      previousContext.characters.some(
        (previousCharacter) => previousCharacter.id === character.existingId,
      )
        ? character.existingId
        : undefined;
    const matchedId =
      existingId ??
      idByName.get(normalizeContextMatchText(character.name)) ??
      character.aliases
        .map((alias) => idByName.get(normalizeContextMatchText(alias)))
        .find((id): id is string => id !== undefined);
    const finalId = matchedId ?? `char_${nextIndex++}`;

    mappings.set(finalId, finalId);
    if (character.existingId !== undefined) {
      mappings.set(character.existingId, finalId);
    }
    if (character.draftKey !== undefined) {
      mappings.set(character.draftKey, finalId);
    }
  }

  return mappings;
}

function buildFactRefMappings(
  previousContext: StoryContextSnapshot,
  draftContext: StoryContextDraftSnapshot,
): ReadonlyMap<string, StoryContextFactId> {
  const mappings = new Map<string, StoryContextFactId>();
  const idByIdentity = new Map<string, StoryContextFactId>();

  for (const fact of previousContext.worldFacts) {
    mappings.set(fact.id, fact.id);
    idByIdentity.set(getWorldFactIdentityKey(fact), fact.id);
  }

  let nextIndex = getNextNumericId(
    previousContext.worldFacts.map((fact) => fact.id),
    "fact_",
  );

  for (const fact of draftContext.worldFacts) {
    const existingId =
      fact.existingId !== undefined &&
      previousContext.worldFacts.some(
        (previousFact) => previousFact.id === fact.existingId,
      )
        ? fact.existingId
        : undefined;
    const matchedId =
      existingId ?? idByIdentity.get(getWorldFactIdentityKey(fact));
    const finalId = matchedId ?? `fact_${nextIndex++}`;

    mappings.set(finalId, finalId);
    if (fact.existingId !== undefined) {
      mappings.set(fact.existingId, finalId);
    }
    if (fact.draftKey !== undefined) {
      mappings.set(fact.draftKey, finalId);
    }
  }

  return mappings;
}

function normalizeWorldFact(
  fact: StoryWorldFactDraft,
  sourceRefToSegmentId: ReadonlyMap<string, string>,
  factRefToId: ReadonlyMap<string, StoryContextFactId>,
): StoryWorldFact {
  const id = resolveRef(getPrimaryDraftRef(fact), factRefToId, "fact");
  return {
    id,
    kind: fact.kind,
    text: fact.text,
    status: fact.status,
    visibility: fact.visibility,
    sourceSegmentIds: mapSourceRefs(fact.sourceRefs, sourceRefToSegmentId),
  };
}

function normalizeCharacter(
  character: StoryCharacterContextDraft,
  sourceRefToSegmentId: ReadonlyMap<string, string>,
  mappings: IdMappings,
): StoryCharacterContext {
  const id = resolveRef(
    getPrimaryDraftRef(character),
    mappings.characterRefToId,
    "character",
  );
  return {
    id,
    name: character.name,
    aliases: uniqueStrings(character.aliases),
    identity: character.identity,
    traits: uniqueStrings(character.traits),
    relationships: normalizeRelationships(
      character.relationships,
      sourceRefToSegmentId,
      mappings.characterRefToId,
    ),
    motivations: uniqueStrings(character.motivations),
    currentStatus: character.currentStatus,
    beliefs: character.beliefs.map((belief) =>
      normalizeBelief(belief, sourceRefToSegmentId, mappings.factRefToId),
    ),
    opinions: character.opinions.map((opinion) => ({
      target: opinion.target,
      text: opinion.text,
      sourceSegmentIds: mapSourceRefs(opinion.sourceRefs, sourceRefToSegmentId),
    })),
    actionTendencies: uniqueStrings(character.actionTendencies),
    sourceSegmentIds: mapSourceRefs(character.sourceRefs, sourceRefToSegmentId),
  };
}

function normalizeRelationships(
  relationships: readonly StoryCharacterRelationshipDraft[],
  sourceRefToSegmentId: ReadonlyMap<string, string>,
  characterRefToId: ReadonlyMap<string, string>,
): StoryCharacterContext["relationships"] {
  return relationships.flatMap((relationship) => {
    const targetCharacterIds = resolveRefs(
      relationship.targetCharacterRefs,
      characterRefToId,
      "character",
    );
    const sourceSegmentIds = mapSourceRefs(
      relationship.sourceRefs,
      sourceRefToSegmentId,
    );
    return targetCharacterIds.map((targetCharacterId) => ({
      targetCharacterId,
      text: relationship.text,
      sourceSegmentIds,
    }));
  });
}

function normalizeBelief(
  belief: StoryCharacterBeliefDraft,
  sourceRefToSegmentId: ReadonlyMap<string, string>,
  factRefToId: ReadonlyMap<string, StoryContextFactId>,
): StoryCharacterContext["beliefs"][number] {
  return {
    text: belief.text,
    truthStatus: belief.truthStatus,
    factIds: resolveRefs(belief.factRefs, factRefToId, "fact"),
    sourceSegmentIds: mapSourceRefs(belief.sourceRefs, sourceRefToSegmentId),
  };
}

function getPrimaryDraftRef(
  value: Readonly<{
    existingId?: string | undefined;
    draftKey?: string | undefined;
  }>,
): string {
  return value.existingId ?? value.draftKey ?? "";
}

function resolveRefs<T extends string>(
  refs: readonly string[],
  mappings: ReadonlyMap<string, T>,
  label: string,
): T[] {
  return uniqueStrings(refs).map((ref) => resolveRef(ref, mappings, label));
}

function resolveRef<T extends string>(
  ref: string,
  mappings: ReadonlyMap<string, T>,
  label: string,
): T {
  const value = mappings.get(ref);
  if (value === undefined) {
    throw new StoryContextFailedError(`Unknown ${label} ref: ${ref}`);
  }

  return value;
}

function mapSourceRefs(
  sourceRefs: readonly string[],
  sourceRefToSegmentId: ReadonlyMap<string, string>,
): string[] {
  return uniqueStrings(sourceRefs).map((ref) => {
    const segmentId = sourceRefToSegmentId.get(ref);
    if (segmentId === undefined) {
      throw new StoryContextFailedError(`Unknown source ref: ${ref}`);
    }

    return segmentId;
  });
}

function getNextNumericId(ids: readonly string[], prefix: string): number {
  const maxId = ids.reduce((currentMax, id) => {
    if (!id.startsWith(prefix)) {
      return currentMax;
    }

    const numericPart = Number(id.slice(prefix.length));
    return Number.isSafeInteger(numericPart) && numericPart > currentMax
      ? numericPart
      : currentMax;
  }, 0);

  return maxId + 1;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function serializeStoryContext(context: StoryContextSnapshot): string {
  const result = StoryContextSnapshotSchema.safeParse(context);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new StoryContextFailedError(
      firstIssue?.message ?? "Story context schema is invalid",
    );
  }

  return JSON.stringify(result.data);
}

export function parseStoryContextJson(value: string): StoryContextSnapshot {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value) as unknown;
  } catch {
    throw new StoryContextFailedError("Story context JSON is invalid");
  }

  const result = StoryContextSnapshotSchema.safeParse(parsedValue);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new StoryContextFailedError(
      firstIssue?.message ?? "Story context schema is invalid",
    );
  }

  return result.data;
}
