import type { StoryContextSnapshot, StoryWorldFactKind } from "@kimiko/schema";
import { z } from "@kimiko/schema";
import type { StoryHistoryRound } from "../story/story.service";
import type {
  StoryContextOperation,
  StoryContextSourceRefMapping,
} from "./storyline-context.types";

export interface GenerateStoryContextPatchInput {
  readonly operation: StoryContextOperation;
  readonly previousContext: StoryContextSnapshot | null;
  readonly sourceRefMappings: readonly StoryContextSourceRefMapping[];
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}

export interface ApplyStoryContextPatchInput {
  readonly previousContext: StoryContextSnapshot | null;
  readonly patch: StoryContextPatchDraft;
  readonly sourceRefToSegmentId: ReadonlyMap<string, string>;
}

const DraftRefSchema = z.string().trim().min(1).max(80);
const SourceRefSchema = z.string().trim().min(1).max(120);
const DraftKeySchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{1,80}$/);
const SourceRefsSchema = z.array(SourceRefSchema).min(1).max(12);

export const StoryWorldFactCreateDraftSchema = z
  .object({
    draftKey: DraftKeySchema,
    kind: z.enum([
      "event",
      "setting",
      "environment",
      "relationship",
      "status",
      "term",
    ] satisfies [StoryWorldFactKind, ...StoryWorldFactKind[]]),
    text: z.string().trim().min(1).max(360),
    status: z.enum(["active", "resolved"]).optional(),
    visibility: z.enum(["observable", "public", "hidden"]).optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryWorldFactCreateDraft = z.infer<
  typeof StoryWorldFactCreateDraftSchema
>;

export const StoryWorldFactUpdateDraftSchema = z
  .object({
    existingId: DraftRefSchema,
    text: z.string().trim().min(1).max(360).optional(),
    status: z.enum(["active", "resolved"]).optional(),
    visibility: z.enum(["observable", "public", "hidden"]).optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.text !== undefined ||
      value.status !== undefined ||
      value.visibility !== undefined ||
      value.sourceRefs !== undefined,
    { message: "at least one fact update field is required" },
  );

export type StoryWorldFactUpdateDraft = z.infer<
  typeof StoryWorldFactUpdateDraftSchema
>;

export const StoryCharacterRelationshipPatchDraftSchema = z
  .object({
    targetCharacterRefs: z.array(DraftRefSchema).min(1).max(8),
    text: z.string().trim().min(1).max(360),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCharacterRelationshipPatchDraft = z.infer<
  typeof StoryCharacterRelationshipPatchDraftSchema
>;

export const StoryCharacterBeliefPatchDraftSchema = z
  .object({
    text: z.string().trim().min(1).max(360),
    truthStatus: z.enum(["true", "false", "unknown"]),
    factRefs: z.array(DraftRefSchema).max(8).optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCharacterBeliefPatchDraft = z.infer<
  typeof StoryCharacterBeliefPatchDraftSchema
>;

export const StoryCharacterOpinionPatchDraftSchema = z
  .object({
    target: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(360),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCharacterOpinionPatchDraft = z.infer<
  typeof StoryCharacterOpinionPatchDraftSchema
>;

export const StoryCharacterCreateDraftSchema = z
  .object({
    draftKey: DraftKeySchema,
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    identity: z.string().trim().max(360).optional(),
    traits: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    relationshipsAdded: z
      .array(StoryCharacterRelationshipPatchDraftSchema)
      .max(8)
      .optional(),
    motivations: z.array(z.string().trim().min(1).max(180)).max(8).optional(),
    currentStatus: z.string().trim().max(360).optional(),
    beliefsAdded: z
      .array(StoryCharacterBeliefPatchDraftSchema)
      .max(8)
      .optional(),
    opinionsAdded: z
      .array(StoryCharacterOpinionPatchDraftSchema)
      .max(6)
      .optional(),
    actionTendenciesAdded: z
      .array(z.string().trim().min(1).max(180))
      .max(6)
      .optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCharacterCreateDraft = z.infer<
  typeof StoryCharacterCreateDraftSchema
>;

export const StoryCharacterPatchDraftSchema = z
  .object({
    existingId: DraftRefSchema,
    aliasesAdded: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    traitsAdded: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    relationshipsAdded: z
      .array(StoryCharacterRelationshipPatchDraftSchema)
      .max(6)
      .optional(),
    motivationsAdded: z
      .array(z.string().trim().min(1).max(180))
      .max(6)
      .optional(),
    currentStatus: z.string().trim().max(360).optional(),
    beliefsAdded: z
      .array(StoryCharacterBeliefPatchDraftSchema)
      .max(8)
      .optional(),
    opinionsAdded: z
      .array(StoryCharacterOpinionPatchDraftSchema)
      .max(6)
      .optional(),
    actionTendenciesAdded: z
      .array(z.string().trim().min(1).max(180))
      .max(6)
      .optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCharacterPatchDraft = z.infer<
  typeof StoryCharacterPatchDraftSchema
>;

export const StoryCurrentScenePatchDraftSchema = z
  .object({
    location: z.string().trim().max(160).optional(),
    timeLabel: z.string().trim().max(160).optional(),
    presentCharacterRefs: z.array(DraftRefSchema).max(20).optional(),
    observableFactRefs: z.array(DraftRefSchema).max(40).optional(),
    sceneStatus: z.string().trim().max(600).optional(),
    sourceRefs: SourceRefsSchema.optional(),
  })
  .strict();

export type StoryCurrentScenePatchDraft = z.infer<
  typeof StoryCurrentScenePatchDraftSchema
>;

export const StoryContextPatchDraftSchema = z
  .object({
    defaultSourceRefs: z
      .array(SourceRefSchema)
      .min(1)
      .max(4)
      .default(["current"]),
    worldFacts: z
      .object({
        add: z.array(StoryWorldFactCreateDraftSchema).max(8).default([]),
        update: z.array(StoryWorldFactUpdateDraftSchema).max(6).default([]),
        resolve: z.array(DraftRefSchema).max(6).default([]),
      })
      .strict()
      .default({ add: [], update: [], resolve: [] }),
    characters: z
      .object({
        add: z.array(StoryCharacterCreateDraftSchema).max(2).default([]),
        update: z.array(StoryCharacterPatchDraftSchema).max(4).default([]),
      })
      .strict()
      .default({ add: [], update: [] }),
    currentScene: StoryCurrentScenePatchDraftSchema.default({}),
  })
  .strict();

export type StoryContextPatchDraft = z.infer<
  typeof StoryContextPatchDraftSchema
>;
