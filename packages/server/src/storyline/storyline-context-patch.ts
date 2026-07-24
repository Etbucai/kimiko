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
} from "./storyline-context.types";
import type {
  ApplyStoryContextPatchInput,
  StoryCharacterBeliefPatchDraft,
  StoryCharacterCreateDraft,
  StoryCharacterOpinionPatchDraft,
  StoryCharacterPatchDraft,
  StoryCharacterRelationshipPatchDraft,
  StoryContextPatchDraft,
  StoryWorldFactCreateDraft,
  StoryWorldFactUpdateDraft,
} from "./storyline-context-patch.types";

interface IdMappings {
  readonly characterRefToId: ReadonlyMap<string, string>;
  readonly factRefToId: ReadonlyMap<string, StoryContextFactId>;
}

export function applyStoryContextPatch(
  input: ApplyStoryContextPatchInput,
): StoryContextSnapshot {
  const previousContext = input.previousContext ?? emptyStoryContextSnapshot;
  const factRefToId = buildFactRefMappings(previousContext, input.patch);
  const characterRefToId = buildCharacterRefMappings(
    previousContext,
    input.patch,
  );
  const mappings: IdMappings = { characterRefToId, factRefToId };
  const worldFacts = applyWorldFactPatch({
    factRefToId,
    patch: input.patch,
    previousContext,
    sourceRefToSegmentId: input.sourceRefToSegmentId,
  });
  const characters = applyCharacterPatch({
    mappings,
    patch: input.patch,
    previousContext,
    sourceRefToSegmentId: input.sourceRefToSegmentId,
  });
  const currentScene = applyCurrentScenePatch({
    mappings,
    patch: input.patch,
    previousContext,
    sourceRefToSegmentId: input.sourceRefToSegmentId,
  });
  const snapshot: StoryContextSnapshot = {
    worldFacts,
    characters,
    currentScene,
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

function buildFactRefMappings(
  previousContext: StoryContextSnapshot,
  patch: StoryContextPatchDraft,
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

  for (const fact of patch.worldFacts.add) {
    const identityKey = getWorldFactIdentityKey({
      kind: fact.kind,
      text: fact.text,
    });
    const finalId = idByIdentity.get(identityKey) ?? `fact_${nextIndex++}`;
    mappings.set(finalId, finalId);
    mappings.set(fact.draftKey, finalId);
    idByIdentity.set(identityKey, finalId);
  }

  return mappings;
}

function buildCharacterRefMappings(
  previousContext: StoryContextSnapshot,
  patch: StoryContextPatchDraft,
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

  for (const character of patch.characters.add) {
    const matchedId =
      idByName.get(normalizeContextMatchText(character.name)) ??
      (character.aliases ?? [])
        .map((alias) => idByName.get(normalizeContextMatchText(alias)))
        .find((id): id is string => id !== undefined);
    const finalId = matchedId ?? `char_${nextIndex++}`;

    mappings.set(finalId, finalId);
    mappings.set(character.draftKey, finalId);
    idByName.set(normalizeContextMatchText(character.name), finalId);
    for (const alias of character.aliases ?? []) {
      idByName.set(normalizeContextMatchText(alias), finalId);
    }
  }

  return mappings;
}

function applyWorldFactPatch(
  input: Readonly<{
    factRefToId: ReadonlyMap<string, StoryContextFactId>;
    patch: StoryContextPatchDraft;
    previousContext: StoryContextSnapshot;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryWorldFact[] {
  const factsById = new Map<string, StoryWorldFact>(
    input.previousContext.worldFacts.map((fact) => [
      fact.id,
      {
        ...fact,
        sourceSegmentIds: [...fact.sourceSegmentIds],
      },
    ]),
  );

  for (const fact of input.patch.worldFacts.add) {
    const id = resolveRef(fact.draftKey, input.factRefToId, "fact");
    const sourceSegmentIds = mapSourceRefs(
      resolvePatchSourceRefs(fact.sourceRefs, input.patch.defaultSourceRefs),
      input.sourceRefToSegmentId,
    );
    const existingFact = factsById.get(id);
    if (existingFact !== undefined) {
      factsById.set(id, {
        ...existingFact,
        sourceSegmentIds: uniqueStrings([
          ...existingFact.sourceSegmentIds,
          ...sourceSegmentIds,
        ]),
      });
      continue;
    }

    factsById.set(id, createWorldFactFromPatch(fact, id, sourceSegmentIds));
  }

  for (const fact of input.patch.worldFacts.update) {
    const id = resolveRef(fact.existingId, input.factRefToId, "fact");
    const existingFact = factsById.get(id);
    if (existingFact === undefined) {
      throw new StoryContextFailedError(`Unknown fact ref: ${fact.existingId}`);
    }

    factsById.set(
      id,
      updateWorldFactFromPatch({
        existingFact,
        patch: fact,
        defaultSourceRefs: input.patch.defaultSourceRefs,
        sourceRefToSegmentId: input.sourceRefToSegmentId,
      }),
    );
  }

  for (const ref of input.patch.worldFacts.resolve) {
    const id = resolveRef(ref, input.factRefToId, "fact");
    const existingFact = factsById.get(id);
    if (existingFact === undefined) {
      throw new StoryContextFailedError(`Unknown fact ref: ${ref}`);
    }

    factsById.set(id, {
      ...existingFact,
      status: "resolved",
    });
  }

  return [...factsById.values()];
}

function createWorldFactFromPatch(
  fact: StoryWorldFactCreateDraft,
  id: StoryContextFactId,
  sourceSegmentIds: readonly string[],
): StoryWorldFact {
  return {
    id,
    kind: fact.kind,
    text: fact.text,
    status: fact.status ?? "active",
    visibility: fact.visibility ?? "observable",
    sourceSegmentIds: [...sourceSegmentIds],
  };
}

function updateWorldFactFromPatch(
  input: Readonly<{
    defaultSourceRefs: readonly string[];
    existingFact: StoryWorldFact;
    patch: StoryWorldFactUpdateDraft;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryWorldFact {
  const sourceSegmentIds =
    input.patch.sourceRefs === undefined
      ? input.existingFact.sourceSegmentIds
      : uniqueStrings([
          ...input.existingFact.sourceSegmentIds,
          ...mapSourceRefs(
            resolvePatchSourceRefs(
              input.patch.sourceRefs,
              input.defaultSourceRefs,
            ),
            input.sourceRefToSegmentId,
          ),
        ]);

  return {
    ...input.existingFact,
    ...(input.patch.text !== undefined ? { text: input.patch.text } : {}),
    ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
    ...(input.patch.visibility !== undefined
      ? { visibility: input.patch.visibility }
      : {}),
    sourceSegmentIds,
  };
}

function applyCharacterPatch(
  input: Readonly<{
    mappings: IdMappings;
    patch: StoryContextPatchDraft;
    previousContext: StoryContextSnapshot;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryCharacterContext[] {
  const charactersById = new Map<string, StoryCharacterContext>(
    input.previousContext.characters.map((character) => [
      character.id,
      cloneCharacter(character),
    ]),
  );

  for (const character of input.patch.characters.add) {
    const id = resolveRef(
      character.draftKey,
      input.mappings.characterRefToId,
      "character",
    );
    const existingCharacter = charactersById.get(id);
    if (existingCharacter !== undefined) {
      charactersById.set(
        id,
        updateExistingCharacterFromCreatePatch({
          character,
          defaultSourceRefs: input.patch.defaultSourceRefs,
          existingCharacter,
          mappings: input.mappings,
          sourceRefToSegmentId: input.sourceRefToSegmentId,
        }),
      );
      continue;
    }

    charactersById.set(
      id,
      createCharacterFromPatch({
        character,
        defaultSourceRefs: input.patch.defaultSourceRefs,
        id,
        mappings: input.mappings,
        sourceRefToSegmentId: input.sourceRefToSegmentId,
      }),
    );
  }

  for (const character of input.patch.characters.update) {
    const id = resolveRef(
      character.existingId,
      input.mappings.characterRefToId,
      "character",
    );
    const existingCharacter = charactersById.get(id);
    if (existingCharacter === undefined) {
      throw new StoryContextFailedError(
        `Unknown character ref: ${character.existingId}`,
      );
    }

    charactersById.set(
      id,
      updateCharacterFromPatch({
        character,
        defaultSourceRefs: input.patch.defaultSourceRefs,
        existingCharacter,
        mappings: input.mappings,
        sourceRefToSegmentId: input.sourceRefToSegmentId,
      }),
    );
  }

  return [...charactersById.values()];
}

function cloneCharacter(
  character: StoryCharacterContext,
): StoryCharacterContext {
  return {
    ...character,
    aliases: [...character.aliases],
    traits: [...character.traits],
    relationships: character.relationships.map((relationship) => ({
      ...relationship,
      sourceSegmentIds: [...relationship.sourceSegmentIds],
    })),
    motivations: [...character.motivations],
    beliefs: character.beliefs.map((belief) => ({
      ...belief,
      factIds: [...belief.factIds],
      sourceSegmentIds: [...belief.sourceSegmentIds],
    })),
    opinions: character.opinions.map((opinion) => ({
      ...opinion,
      sourceSegmentIds: [...opinion.sourceSegmentIds],
    })),
    actionTendencies: [...character.actionTendencies],
    sourceSegmentIds: [...character.sourceSegmentIds],
  };
}

function createCharacterFromPatch(
  input: Readonly<{
    character: StoryCharacterCreateDraft;
    defaultSourceRefs: readonly string[];
    id: string;
    mappings: IdMappings;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryCharacterContext {
  const sourceSegmentIds = mapSourceRefs(
    resolvePatchSourceRefs(input.character.sourceRefs, input.defaultSourceRefs),
    input.sourceRefToSegmentId,
  );

  return {
    id: input.id,
    name: input.character.name,
    aliases: uniqueStrings(input.character.aliases ?? []),
    identity: input.character.identity ?? "",
    traits: uniqueStrings(input.character.traits ?? []),
    relationships: normalizeRelationships(
      input.character.relationshipsAdded ?? [],
      input.defaultSourceRefs,
      input.sourceRefToSegmentId,
      input.mappings.characterRefToId,
    ),
    motivations: uniqueStrings(input.character.motivations ?? []),
    currentStatus: input.character.currentStatus ?? "",
    beliefs: normalizeBeliefs(
      input.character.beliefsAdded ?? [],
      input.defaultSourceRefs,
      input.sourceRefToSegmentId,
      input.mappings.factRefToId,
    ),
    opinions: normalizeOpinions(
      input.character.opinionsAdded ?? [],
      input.defaultSourceRefs,
      input.sourceRefToSegmentId,
    ),
    actionTendencies: uniqueStrings(
      input.character.actionTendenciesAdded ?? [],
    ),
    sourceSegmentIds,
  };
}

function updateExistingCharacterFromCreatePatch(
  input: Readonly<{
    character: StoryCharacterCreateDraft;
    defaultSourceRefs: readonly string[];
    existingCharacter: StoryCharacterContext;
    mappings: IdMappings;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryCharacterContext {
  return updateCharacterCommon({
    aliasesAdded: input.character.aliases,
    traitsAdded: input.character.traits,
    relationshipsAdded: input.character.relationshipsAdded,
    motivationsAdded: input.character.motivations,
    currentStatus: input.character.currentStatus,
    beliefsAdded: input.character.beliefsAdded,
    opinionsAdded: input.character.opinionsAdded,
    actionTendenciesAdded: input.character.actionTendenciesAdded,
    sourceRefs: input.character.sourceRefs,
    defaultSourceRefs: input.defaultSourceRefs,
    existingCharacter: input.existingCharacter,
    mappings: input.mappings,
    sourceRefToSegmentId: input.sourceRefToSegmentId,
  });
}

function updateCharacterFromPatch(
  input: Readonly<{
    character: StoryCharacterPatchDraft;
    defaultSourceRefs: readonly string[];
    existingCharacter: StoryCharacterContext;
    mappings: IdMappings;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryCharacterContext {
  return updateCharacterCommon({
    aliasesAdded: input.character.aliasesAdded,
    traitsAdded: input.character.traitsAdded,
    relationshipsAdded: input.character.relationshipsAdded,
    motivationsAdded: input.character.motivationsAdded,
    currentStatus: input.character.currentStatus,
    beliefsAdded: input.character.beliefsAdded,
    opinionsAdded: input.character.opinionsAdded,
    actionTendenciesAdded: input.character.actionTendenciesAdded,
    sourceRefs: input.character.sourceRefs,
    defaultSourceRefs: input.defaultSourceRefs,
    existingCharacter: input.existingCharacter,
    mappings: input.mappings,
    sourceRefToSegmentId: input.sourceRefToSegmentId,
  });
}

function updateCharacterCommon(
  input: Readonly<{
    actionTendenciesAdded: readonly string[] | undefined;
    aliasesAdded: readonly string[] | undefined;
    beliefsAdded: readonly StoryCharacterBeliefPatchDraft[] | undefined;
    currentStatus: string | undefined;
    defaultSourceRefs: readonly string[];
    existingCharacter: StoryCharacterContext;
    mappings: IdMappings;
    motivationsAdded: readonly string[] | undefined;
    opinionsAdded: readonly StoryCharacterOpinionPatchDraft[] | undefined;
    relationshipsAdded:
      readonly StoryCharacterRelationshipPatchDraft[] | undefined;
    sourceRefs: readonly string[] | undefined;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
    traitsAdded: readonly string[] | undefined;
  }>,
): StoryCharacterContext {
  const sourceSegmentIds =
    input.sourceRefs === undefined
      ? input.existingCharacter.sourceSegmentIds
      : uniqueStrings([
          ...input.existingCharacter.sourceSegmentIds,
          ...mapSourceRefs(
            resolvePatchSourceRefs(input.sourceRefs, input.defaultSourceRefs),
            input.sourceRefToSegmentId,
          ),
        ]);

  return {
    ...input.existingCharacter,
    aliases: uniqueStrings([
      ...input.existingCharacter.aliases,
      ...(input.aliasesAdded ?? []),
    ]),
    traits: uniqueStrings([
      ...input.existingCharacter.traits,
      ...(input.traitsAdded ?? []),
    ]),
    relationships: [
      ...input.existingCharacter.relationships,
      ...normalizeRelationships(
        input.relationshipsAdded ?? [],
        input.defaultSourceRefs,
        input.sourceRefToSegmentId,
        input.mappings.characterRefToId,
      ),
    ],
    motivations: uniqueStrings([
      ...input.existingCharacter.motivations,
      ...(input.motivationsAdded ?? []),
    ]),
    currentStatus: input.currentStatus ?? input.existingCharacter.currentStatus,
    beliefs: [
      ...input.existingCharacter.beliefs,
      ...normalizeBeliefs(
        input.beliefsAdded ?? [],
        input.defaultSourceRefs,
        input.sourceRefToSegmentId,
        input.mappings.factRefToId,
      ),
    ],
    opinions: [
      ...input.existingCharacter.opinions,
      ...normalizeOpinions(
        input.opinionsAdded ?? [],
        input.defaultSourceRefs,
        input.sourceRefToSegmentId,
      ),
    ],
    actionTendencies: uniqueStrings([
      ...input.existingCharacter.actionTendencies,
      ...(input.actionTendenciesAdded ?? []),
    ]),
    sourceSegmentIds,
  };
}

function normalizeRelationships(
  relationships: readonly StoryCharacterRelationshipPatchDraft[],
  defaultSourceRefs: readonly string[],
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
      resolvePatchSourceRefs(relationship.sourceRefs, defaultSourceRefs),
      sourceRefToSegmentId,
    );
    return targetCharacterIds.map((targetCharacterId) => ({
      targetCharacterId,
      text: relationship.text,
      sourceSegmentIds,
    }));
  });
}

function normalizeBeliefs(
  beliefs: readonly StoryCharacterBeliefPatchDraft[],
  defaultSourceRefs: readonly string[],
  sourceRefToSegmentId: ReadonlyMap<string, string>,
  factRefToId: ReadonlyMap<string, StoryContextFactId>,
): StoryCharacterContext["beliefs"] {
  return beliefs.map((belief) => ({
    text: belief.text,
    truthStatus: belief.truthStatus,
    // Belief fact refs are optional grounding metadata. Keep the known facts and
    // drop dangling refs so one bad model token does not fail the whole patch.
    factIds: resolveKnownRefs(belief.factRefs ?? [], factRefToId),
    sourceSegmentIds: mapSourceRefs(
      resolvePatchSourceRefs(belief.sourceRefs, defaultSourceRefs),
      sourceRefToSegmentId,
    ),
  }));
}

function normalizeOpinions(
  opinions: readonly StoryCharacterOpinionPatchDraft[],
  defaultSourceRefs: readonly string[],
  sourceRefToSegmentId: ReadonlyMap<string, string>,
): StoryCharacterContext["opinions"] {
  return opinions.map((opinion) => ({
    target: opinion.target,
    text: opinion.text,
    sourceSegmentIds: mapSourceRefs(
      resolvePatchSourceRefs(opinion.sourceRefs, defaultSourceRefs),
      sourceRefToSegmentId,
    ),
  }));
}

function applyCurrentScenePatch(
  input: Readonly<{
    mappings: IdMappings;
    patch: StoryContextPatchDraft;
    previousContext: StoryContextSnapshot;
    sourceRefToSegmentId: ReadonlyMap<string, string>;
  }>,
): StoryContextSnapshot["currentScene"] {
  const currentScene = input.patch.currentScene;
  const previousScene = input.previousContext.currentScene;
  const presentCharacterRefs =
    currentScene.presentCharacterRefs ?? previousScene.presentCharacterIds;
  const observableFactRefs =
    currentScene.observableFactRefs ?? previousScene.observableFactIds;

  return {
    location: currentScene.location ?? previousScene.location,
    timeLabel: currentScene.timeLabel ?? previousScene.timeLabel,
    presentCharacterIds: resolveRefs(
      presentCharacterRefs,
      input.mappings.characterRefToId,
      "character",
    ),
    observableFactIds: resolveRefs(
      observableFactRefs,
      input.mappings.factRefToId,
      "fact",
    ),
    sceneStatus: currentScene.sceneStatus ?? previousScene.sceneStatus,
    sourceSegmentIds: mapSourceRefs(
      resolvePatchSourceRefs(
        currentScene.sourceRefs,
        input.patch.defaultSourceRefs,
      ),
      input.sourceRefToSegmentId,
    ),
  };
}

function resolvePatchSourceRefs(
  sourceRefs: readonly string[] | undefined,
  defaultSourceRefs: readonly string[],
): string[] {
  return sourceRefs === undefined || sourceRefs.length === 0
    ? uniqueStrings(defaultSourceRefs)
    : uniqueStrings(sourceRefs);
}

function resolveRefs<T extends string>(
  refs: readonly string[],
  mappings: ReadonlyMap<string, T>,
  label: string,
): T[] {
  return uniqueStrings(refs).map((ref) => resolveRef(ref, mappings, label));
}

function resolveKnownRefs<T extends string>(
  refs: readonly string[],
  mappings: ReadonlyMap<string, T>,
): T[] {
  return uniqueStrings(refs).flatMap((ref) => {
    const value = mappings.get(ref);
    return value === undefined ? [] : [value];
  });
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
