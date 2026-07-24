import type { z } from "@kimiko/schema";
import { StoryContextPatchDraftSchema } from "./storyline-context-patch.types";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";

export type StoryContextPatchRepairResult =
  | Readonly<{ success: true; patch: StoryContextPatchDraft }>
  | Readonly<{ success: false; message: string }>;

type JsonObject = Record<string, unknown>;

export function repairStoryContextPatchValue(
  value: unknown,
): StoryContextPatchRepairResult {
  if (!isJsonObject(value)) {
    return { success: false, message: "Context patch must be a JSON object" };
  }

  const repairedValue = repairRoot(value);
  const result = StoryContextPatchDraftSchema.safeParse(repairedValue);
  if (!result.success) {
    return { success: false, message: getFirstIssueMessage(result.error) };
  }

  return { success: true, patch: result.data };
}

function repairRoot(value: JsonObject): JsonObject {
  const defaultSourceRefs = repairStringArray(value.defaultSourceRefs, [
    "current",
  ]);
  return {
    ...value,
    defaultSourceRefs,
    worldFacts: repairWorldFacts(value.worldFacts),
    characters: repairCharacters(value.characters),
    currentScene: repairCurrentScene(value.currentScene),
  };
}

function repairWorldFacts(value: unknown): JsonObject {
  const worldFacts = isJsonObject(value) ? value : {};
  return {
    ...worldFacts,
    add: repairObjectArray(worldFacts.add).map(repairFactCreate),
    update: repairObjectArray(worldFacts.update).map(repairFactUpdate),
    resolve: repairStringArray(worldFacts.resolve, []),
  };
}

function repairFactCreate(value: JsonObject): JsonObject {
  return {
    ...value,
    status: repairStatus(value.status),
    visibility: repairVisibility(value.visibility),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairFactUpdate(value: JsonObject): JsonObject {
  return {
    ...value,
    status: value.status === undefined ? undefined : repairStatus(value.status),
    visibility:
      value.visibility === undefined
        ? undefined
        : repairVisibility(value.visibility),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairCharacters(value: unknown): JsonObject {
  const characters = isJsonObject(value) ? value : {};
  return {
    ...characters,
    add: repairObjectArray(characters.add).map(repairCharacterCreate),
    update: repairObjectArray(characters.update).map(repairCharacterPatch),
  };
}

function repairCharacterCreate(value: JsonObject): JsonObject {
  return {
    ...value,
    aliases: repairOptionalStringArray(value.aliases),
    traits: repairOptionalStringArray(value.traits),
    relationshipsAdded: repairObjectArray(value.relationshipsAdded).map(
      repairRelationship,
    ),
    motivations: repairOptionalStringArray(value.motivations),
    beliefsAdded: repairObjectArray(value.beliefsAdded).map(repairBelief),
    opinionsAdded: repairObjectArray(value.opinionsAdded).map(repairOpinion),
    actionTendenciesAdded: repairOptionalStringArray(
      value.actionTendenciesAdded,
    ),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairCharacterPatch(value: JsonObject): JsonObject {
  return {
    ...value,
    aliasesAdded: repairOptionalStringArray(value.aliasesAdded),
    traitsAdded: repairOptionalStringArray(value.traitsAdded),
    relationshipsAdded: repairObjectArray(value.relationshipsAdded).map(
      repairRelationship,
    ),
    motivationsAdded: repairOptionalStringArray(value.motivationsAdded),
    beliefsAdded: repairObjectArray(value.beliefsAdded).map(repairBelief),
    opinionsAdded: repairObjectArray(value.opinionsAdded).map(repairOpinion),
    actionTendenciesAdded: repairOptionalStringArray(
      value.actionTendenciesAdded,
    ),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairRelationship(value: JsonObject): JsonObject {
  return {
    ...value,
    targetCharacterRefs: repairStringArray(value.targetCharacterRefs, []),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairBelief(value: JsonObject): JsonObject {
  return {
    ...value,
    truthStatus: repairTruthStatus(value.truthStatus),
    factRefs: repairStringArray(value.factRefs, []),
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairOpinion(value: JsonObject): JsonObject {
  return {
    ...value,
    sourceRefs: repairOptionalStringArray(value.sourceRefs),
  };
}

function repairCurrentScene(value: unknown): JsonObject {
  const currentScene = isJsonObject(value) ? value : {};
  return {
    ...currentScene,
    presentCharacterRefs: repairOptionalStringArray(
      currentScene.presentCharacterRefs,
    ),
    observableFactRefs: repairOptionalStringArray(
      currentScene.observableFactRefs,
    ),
    sourceRefs: repairOptionalStringArray(currentScene.sourceRefs),
  };
}

function repairStatus(value: unknown): "active" | "resolved" {
  return value === "resolved" ? "resolved" : "active";
}

function repairVisibility(value: unknown): "observable" | "public" | "hidden" {
  if (value === "public" || value === "hidden") {
    return value;
  }

  return "observable";
}

function repairTruthStatus(value: unknown): "true" | "false" | "unknown" {
  if (value === "true" || value === "false") {
    return value;
  }

  return "unknown";
}

function repairObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function repairStringArray(
  value: unknown,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function repairOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return repairStringArray(value, []);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFirstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Context patch schema is invalid";
}
