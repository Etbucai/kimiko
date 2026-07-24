import type {
  StoryContextSnapshot,
  StoryWorldFact,
  StoryWorldFactKind,
} from "@kimiko/schema";
import { StoryContextSnapshotSchema, z } from "@kimiko/schema";
import type { StoryHistoryRound } from "../story/story.service";

export { StoryContextSnapshotSchema };
export type { StoryContextSnapshot };

export type StoryContextOperation = "create" | "append" | "rewrite" | "dialogue";

export interface StoryContextSourceRefMapping {
  readonly ref: string;
  readonly label: string;
  readonly text: string;
}

export interface GenerateStoryContextInput {
  readonly operation: StoryContextOperation;
  readonly previousContext: StoryContextSnapshot | null;
  readonly sourceRefMappings: readonly StoryContextSourceRefMapping[];
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}

export interface NormalizeStoryContextDraftInput {
  readonly previousContext: StoryContextSnapshot | null;
  readonly draftContext: StoryContextDraftSnapshot;
  readonly sourceRefToSegmentId: ReadonlyMap<string, string>;
}

const DraftRefSchema = z.string().trim().min(1).max(80);
const SourceRefSchema = z.string().trim().min(1).max(120);
const DraftKeySchema = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const StoryWorldFactDraftSchema = z
  .object({
    existingId: z.string().trim().optional(),
    draftKey: DraftKeySchema.optional(),
    kind: z.enum([
      "event",
      "setting",
      "environment",
      "relationship",
      "status",
      "term",
    ] satisfies [StoryWorldFactKind, ...StoryWorldFactKind[]]),
    text: z.string().trim().min(1).max(360),
    status: z.enum(["active", "resolved"]),
    visibility: z.enum(["observable", "public", "hidden"]),
    sourceRefs: z.array(SourceRefSchema).min(1).max(12),
  })
  .strict()
  .refine(
    (value) =>
      value.existingId !== undefined || value.draftKey !== undefined,
    { message: "existingId or draftKey is required" },
  );

export type StoryWorldFactDraft = z.infer<typeof StoryWorldFactDraftSchema>;

export const StoryCharacterRelationshipDraftSchema = z
  .object({
    targetCharacterRefs: z.array(DraftRefSchema).min(1).max(8),
    text: z.string().trim().min(1).max(360),
    sourceRefs: z.array(SourceRefSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterRelationshipDraft = z.infer<
  typeof StoryCharacterRelationshipDraftSchema
>;

export const StoryCharacterBeliefDraftSchema = z
  .object({
    text: z.string().trim().min(1).max(360),
    truthStatus: z.enum(["true", "false", "unknown"]),
    factRefs: z.array(DraftRefSchema).max(8),
    sourceRefs: z.array(SourceRefSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterBeliefDraft = z.infer<
  typeof StoryCharacterBeliefDraftSchema
>;

export const StoryCharacterOpinionDraftSchema = z
  .object({
    target: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(360),
    sourceRefs: z.array(SourceRefSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterOpinionDraft = z.infer<
  typeof StoryCharacterOpinionDraftSchema
>;

export const StoryCharacterContextDraftSchema = z
  .object({
    existingId: z.string().trim().optional(),
    draftKey: DraftKeySchema.optional(),
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10),
    identity: z.string().trim().max(360),
    traits: z.array(z.string().trim().min(1).max(120)).max(20),
    relationships: z.array(StoryCharacterRelationshipDraftSchema).max(30),
    motivations: z.array(z.string().trim().min(1).max(180)).max(20),
    currentStatus: z.string().trim().max(360),
    beliefs: z.array(StoryCharacterBeliefDraftSchema).max(30),
    opinions: z.array(StoryCharacterOpinionDraftSchema).max(20),
    actionTendencies: z.array(z.string().trim().min(1).max(180)).max(12),
    sourceRefs: z.array(SourceRefSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.existingId !== undefined || value.draftKey !== undefined,
    { message: "existingId or draftKey is required" },
  );

export type StoryCharacterContextDraft = z.infer<
  typeof StoryCharacterContextDraftSchema
>;

export const StoryCurrentSceneDraftSchema = z
  .object({
    location: z.string().trim().max(160),
    timeLabel: z.string().trim().max(160),
    presentCharacterRefs: z.array(DraftRefSchema).max(20),
    observableFactRefs: z.array(DraftRefSchema).max(40),
    sceneStatus: z.string().trim().max(600),
    sourceRefs: z.array(SourceRefSchema).max(12),
  })
  .strict();

export type StoryCurrentSceneDraft = z.infer<
  typeof StoryCurrentSceneDraftSchema
>;

export const StoryContextDraftSnapshotSchema = z
  .object({
    worldFacts: z.array(StoryWorldFactDraftSchema).max(80),
    characters: z.array(StoryCharacterContextDraftSchema).max(20),
    currentScene: StoryCurrentSceneDraftSchema,
  })
  .strict();

export type StoryContextDraftSnapshot = z.infer<
  typeof StoryContextDraftSnapshotSchema
>;

export const emptyStoryContextSnapshot: StoryContextSnapshot = {
  worldFacts: [],
  characters: [],
  currentScene: {
    location: "",
    timeLabel: "",
    presentCharacterIds: [],
    observableFactIds: [],
    sceneStatus: "",
    sourceSegmentIds: [],
  },
};

export const STORY_CONTEXT_LIMITS = {
  characters: 20,
  worldFacts: 80,
  characterBeliefs: 30,
  characterOpinions: 20,
  characterRelationships: 30,
  characterActionTendencies: 12,
  activeCharacters: 8,
  observableFactsForPrompt: 40,
} as const satisfies Readonly<Record<string, number>>;

export function getWorldFactIdentityKey(
  fact: Pick<StoryWorldFact, "kind" | "text">,
): string {
  return `${fact.kind}:${normalizeContextMatchText(fact.text)}`;
}

export function normalizeContextMatchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
