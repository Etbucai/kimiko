import { z } from "zod";

export { z };

export const HealthStatusSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  timestamp: z.string().datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const TokenType = {
  Bearer: "Bearer",
} as const;

export const TokenTypeSchema = z.literal(TokenType.Bearer);

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const RegisterUserRequestSchema = z
  .object({
    uniqueName: z.string().trim().min(3).max(32),
    displayName: z.string().trim().min(1).max(64),
    password: z.string().min(8).max(72),
  })
  .strict();

export type RegisterUserRequest = z.infer<typeof RegisterUserRequestSchema>;

export const RegisterUserResponseSchema = z
  .object({
    userId: z.string(),
  })
  .strict();

export type RegisterUserResponse = z.infer<typeof RegisterUserResponseSchema>;

export const LoginUserRequestSchema = z
  .object({
    uniqueName: z.string().trim().min(3).max(32),
    password: z.string().min(1),
  })
  .strict();

export type LoginUserRequest = z.infer<typeof LoginUserRequestSchema>;

export const LoginSessionSchema = z
  .object({
    userId: z.string(),
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: TokenTypeSchema,
    expiresIn: z.number().int().positive(),
  })
  .strict();

export type LoginSession = z.infer<typeof LoginSessionSchema>;

export const GetMyUserInfoResponseSchema = z
  .object({
    userId: z.string(),
    uniqueName: z.string(),
    displayName: z.string(),
    avatarUrl: z.string(),
  })
  .strict();

export type GetMyUserInfoResponse = z.infer<typeof GetMyUserInfoResponseSchema>;

export const LoginUserResponseSchema = z
  .object({
    session: LoginSessionSchema,
    me: GetMyUserInfoResponseSchema,
  })
  .strict();

export type LoginUserResponse = z.infer<typeof LoginUserResponseSchema>;

export const RefreshTokenRequestSchema = z
  .object({
    refreshToken: z.string().trim().min(1),
  })
  .strict();

export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;

export const RefreshTokenResponseSchema = z
  .object({
    session: LoginSessionSchema,
  })
  .strict();

export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;

export const LogoutUserRequestSchema = RefreshTokenRequestSchema;

export type LogoutUserRequest = z.infer<typeof LogoutUserRequestSchema>;

export const LogoutUserResponseSchema = z.object({}).strict();

export type LogoutUserResponse = z.infer<typeof LogoutUserResponseSchema>;

const OptionalPromptSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : undefined;
}, z.string().trim().min(1).max(8_000).optional());

export const GenerateLlmTextRequestSchema = z
  .object({
    userPrompt: z.string().trim().min(1).max(20_000),
    systemPrompt: OptionalPromptSchema,
  })
  .strict();

export type GenerateLlmTextRequest = z.infer<
  typeof GenerateLlmTextRequestSchema
>;

export const GenerateLlmTextUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export type GenerateLlmTextUsage = z.infer<typeof GenerateLlmTextUsageSchema>;

export const GenerateLlmTextResponseSchema = z
  .object({
    text: z.string().min(1),
    model: z.string().min(1),
    usage: GenerateLlmTextUsageSchema.optional(),
    finishReason: z.string().min(1).optional(),
  })
  .strict();

export type GenerateLlmTextResponse = z.infer<
  typeof GenerateLlmTextResponseSchema
>;

export const GenerateLlmTextStreamUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export type GenerateLlmTextStreamUsage = z.infer<
  typeof GenerateLlmTextStreamUsageSchema
>;

export const GenerateLlmTextStreamStartedEventSchema = z
  .object({
    type: z.literal("started"),
  })
  .strict();

export type GenerateLlmTextStreamStartedEvent = z.infer<
  typeof GenerateLlmTextStreamStartedEventSchema
>;

export const GenerateLlmTextStreamChunkEventSchema = z
  .object({
    type: z.literal("chunk"),
    sequence: z.number().int().positive(),
    delta: z.string().min(1),
  })
  .strict();

export type GenerateLlmTextStreamChunkEvent = z.infer<
  typeof GenerateLlmTextStreamChunkEventSchema
>;

export const GenerateLlmTextStreamCompletedEventSchema = z
  .object({
    type: z.literal("completed"),
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: GenerateLlmTextStreamUsageSchema,
    finishReason: z.string().trim().min(1).optional(),
  })
  .strict();

export type GenerateLlmTextStreamCompletedEvent = z.infer<
  typeof GenerateLlmTextStreamCompletedEventSchema
>;

export const GenerateLlmTextStreamErrorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().min(1),
  })
  .strict();

export type GenerateLlmTextStreamErrorEvent = z.infer<
  typeof GenerateLlmTextStreamErrorEventSchema
>;

export const GenerateLlmTextStreamEventSchema = z.discriminatedUnion("type", [
  GenerateLlmTextStreamStartedEventSchema,
  GenerateLlmTextStreamChunkEventSchema,
  GenerateLlmTextStreamCompletedEventSchema,
  GenerateLlmTextStreamErrorEventSchema,
]);

export type GenerateLlmTextStreamEvent = z.infer<
  typeof GenerateLlmTextStreamEventSchema
>;

export const ContinueStoryRequestSchema = z
  .object({
    storyText: z.string().trim().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type ContinueStoryRequest = z.infer<typeof ContinueStoryRequestSchema>;

export const ContinueStoryUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export type ContinueStoryUsage = z.infer<typeof ContinueStoryUsageSchema>;

export const ContinueStoryResponseSchema = z
  .object({
    continuedStory: z.string().trim().min(1),
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
  })
  .strict();

export type ContinueStoryResponse = z.infer<typeof ContinueStoryResponseSchema>;

export const StorylineIdSchema = z.string().trim().min(1);

export type StorylineId = z.infer<typeof StorylineIdSchema>;

export const StorylineSegmentIdSchema = z.string().trim().min(1);

export type StorylineSegmentId = z.infer<typeof StorylineSegmentIdSchema>;

export const StoryTargetLengthSchema = z.number().int().min(100).max(1_200);

export type StoryTargetLength = z.infer<typeof StoryTargetLengthSchema>;

export const StorylineGenerationModeSchema = z.enum(["append", "dialogue"]);

export type StorylineGenerationMode = z.infer<
  typeof StorylineGenerationModeSchema
>;

export const StorylineInitialSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("initial"),
    text: z.string().trim().min(1),
  })
  .strict();

export type StorylineInitialSegment = z.infer<
  typeof StorylineInitialSegmentSchema
>;

export const StorylineGeneratedSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("generated"),
    generationMode: StorylineGenerationModeSchema,
    text: z.string().trim().min(1),
  })
  .strict();

export type StorylineGeneratedSegment = z.infer<
  typeof StorylineGeneratedSegmentSchema
>;

export const StorylineSegmentSchema = z.discriminatedUnion("type", [
  StorylineInitialSegmentSchema,
  StorylineGeneratedSegmentSchema,
]);

export type StorylineSegment = z.infer<typeof StorylineSegmentSchema>;

export const StorylineGenerationMetadataSchema = z
  .object({
    segmentId: StorylineSegmentIdSchema,
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
  })
  .strict();

export type StorylineGenerationMetadata = z.infer<
  typeof StorylineGenerationMetadataSchema
>;

export const StorylineSnapshotSchema = z
  .object({
    id: StorylineIdSchema,
    segments: z.array(StorylineSegmentSchema).min(1),
    latestGeneration: StorylineGenerationMetadataSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type StorylineSnapshot = z.infer<typeof StorylineSnapshotSchema>;

export const CompletedStorylineSnapshotSchema = StorylineSnapshotSchema.extend({
  latestGeneration: StorylineGenerationMetadataSchema,
});

export type CompletedStorylineSnapshot = z.infer<
  typeof CompletedStorylineSnapshotSchema
>;

export const StorylineListItemSchema = z
  .object({
    id: StorylineIdSchema,
    title: z.string().trim().min(1).max(80),
    preview: z.string().trim().min(1).max(240),
    updatedAt: z.string().datetime(),
    segmentCount: z.number().int().positive(),
    chapterCount: z.number().int().positive(),
  })
  .strict();

export type StorylineListItem = z.infer<typeof StorylineListItemSchema>;

export const ListStorylinesResponseSchema = z
  .object({
    storylines: z.array(StorylineListItemSchema).max(50),
  })
  .strict();

export type ListStorylinesResponse = z.infer<
  typeof ListStorylinesResponseSchema
>;

export const GetStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema,
  })
  .strict();

export type GetStorylineResponse = z.infer<typeof GetStorylineResponseSchema>;

export const GetRecentStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema.nullable(),
  })
  .strict();

export type GetRecentStorylineResponse = z.infer<
  typeof GetRecentStorylineResponseSchema
>;

export const StoryCharacterSummarySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(5),
    identity: z.string().trim().min(1).max(240),
    relationships: z.array(z.string().trim().min(1).max(240)).max(12),
    motivation: z.string().trim().max(240),
    currentStatus: z.string().trim().max(240),
  })
  .strict();

export type StoryCharacterSummary = z.infer<typeof StoryCharacterSummarySchema>;

export const StoryCharacterSummarySnapshotSchema = z
  .object({
    characters: z.array(StoryCharacterSummarySchema).max(12),
  })
  .strict();

export type StoryCharacterSummarySnapshot = z.infer<
  typeof StoryCharacterSummarySnapshotSchema
>;

export const StoryContextCharacterIdSchema = z
  .string()
  .trim()
  .regex(/^char_[1-9]\d*$/);

export type StoryContextCharacterId = z.infer<
  typeof StoryContextCharacterIdSchema
>;

export const StoryContextFactIdSchema = z
  .string()
  .trim()
  .regex(/^fact_[1-9]\d*$/);

export type StoryContextFactId = z.infer<typeof StoryContextFactIdSchema>;

export const StoryWorldFactKindSchema = z.enum([
  "event",
  "setting",
  "environment",
  "relationship",
  "status",
  "term",
]);

export type StoryWorldFactKind = z.infer<typeof StoryWorldFactKindSchema>;

export const StoryWorldFactSchema = z
  .object({
    id: StoryContextFactIdSchema,
    kind: StoryWorldFactKindSchema,
    text: z.string().trim().min(1).max(360),
    status: z.enum(["active", "resolved"]),
    visibility: z.enum(["observable", "public", "hidden"]),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();

export type StoryWorldFact = z.infer<typeof StoryWorldFactSchema>;

export const StoryCharacterBeliefSchema = z
  .object({
    text: z.string().trim().min(1).max(360),
    truthStatus: z.enum(["true", "false", "unknown"]),
    factIds: z.array(StoryContextFactIdSchema).max(8),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterBelief = z.infer<typeof StoryCharacterBeliefSchema>;

export const StoryCharacterOpinionSchema = z
  .object({
    target: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(360),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterOpinion = z.infer<typeof StoryCharacterOpinionSchema>;

export const StoryCharacterRelationshipSchema = z
  .object({
    targetCharacterId: StoryContextCharacterIdSchema,
    text: z.string().trim().min(1).max(360),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();

export type StoryCharacterRelationship = z.infer<
  typeof StoryCharacterRelationshipSchema
>;

export const StoryCharacterContextSchema = z
  .object({
    id: StoryContextCharacterIdSchema,
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10),
    identity: z.string().trim().max(360),
    traits: z.array(z.string().trim().min(1).max(120)).max(20),
    relationships: z.array(StoryCharacterRelationshipSchema).max(30),
    motivations: z.array(z.string().trim().min(1).max(180)).max(20),
    currentStatus: z.string().trim().max(360),
    beliefs: z.array(StoryCharacterBeliefSchema).max(30),
    opinions: z.array(StoryCharacterOpinionSchema).max(20),
    actionTendencies: z.array(z.string().trim().min(1).max(180)).max(12),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(20),
  })
  .strict();

export type StoryCharacterContext = z.infer<typeof StoryCharacterContextSchema>;

export const StoryCurrentSceneSchema = z
  .object({
    location: z.string().trim().max(160),
    timeLabel: z.string().trim().max(160),
    presentCharacterIds: z.array(StoryContextCharacterIdSchema).max(20),
    observableFactIds: z.array(StoryContextFactIdSchema).max(40),
    sceneStatus: z.string().trim().max(600),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).max(12),
  })
  .strict();

export type StoryCurrentScene = z.infer<typeof StoryCurrentSceneSchema>;

export const StoryContextSnapshotSchema = z
  .object({
    worldFacts: z.array(StoryWorldFactSchema).max(80),
    characters: z.array(StoryCharacterContextSchema).max(20),
    currentScene: StoryCurrentSceneSchema,
  })
  .strict();

export type StoryContextSnapshot = z.infer<typeof StoryContextSnapshotSchema>;

export const GetStorylineSummaryResponseSchema = z
  .object({
    summary: StoryCharacterSummarySnapshotSchema.nullable(),
  })
  .strict();

export type GetStorylineSummaryResponse = z.infer<
  typeof GetStorylineSummaryResponseSchema
>;

export const GetStorylineContextResponseSchema = z
  .object({
    context: StoryContextSnapshotSchema.nullable(),
  })
  .strict();

export type GetStorylineContextResponse = z.infer<
  typeof GetStorylineContextResponseSchema
>;

export const StoryContinueCreatePayloadSchema = z
  .object({
    mode: z.literal("create"),
    initialStoryText: z.string().trim().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueCreatePayload = z.infer<
  typeof StoryContinueCreatePayloadSchema
>;

export const StoryContinueAppendPayloadSchema = z
  .object({
    mode: z.literal("append"),
    storylineId: StorylineIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
    targetLength: StoryTargetLengthSchema,
  })
  .strict();

export type StoryContinueAppendPayload = z.infer<
  typeof StoryContinueAppendPayloadSchema
>;

export const StoryContinueRewritePayloadSchema = z
  .object({
    mode: z.literal("rewrite"),
    storylineId: StorylineIdSchema,
    segmentId: StorylineSegmentIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueRewritePayload = z.infer<
  typeof StoryContinueRewritePayloadSchema
>;

export const StoryContinueDialoguePayloadSchema = z
  .object({
    mode: z.literal("dialogue"),
    storylineId: StorylineIdSchema,
    input: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type StoryContinueDialoguePayload = z.infer<
  typeof StoryContinueDialoguePayloadSchema
>;

export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
  StoryContinueDialoguePayloadSchema,
]);

export type StoryContinuePayload = z.infer<typeof StoryContinuePayloadSchema>;

export const StoryRealtimeRequestIdSchema = z.string().trim().min(1);

export const StoryContinueClientMessageSchema = z
  .object({
    type: z.literal("story.continue"),
    requestId: StoryRealtimeRequestIdSchema,
    payload: StoryContinuePayloadSchema,
  })
  .strict();

export type StoryContinueClientMessage = z.infer<
  typeof StoryContinueClientMessageSchema
>;

export const StoryCancelClientMessageSchema = z
  .object({
    type: z.literal("story.cancel"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryCancelClientMessage = z.infer<
  typeof StoryCancelClientMessageSchema
>;

export const StoryRealtimeClientMessageSchema = z.discriminatedUnion("type", [
  StoryContinueClientMessageSchema,
  StoryCancelClientMessageSchema,
]);

export type StoryRealtimeClientMessage = z.infer<
  typeof StoryRealtimeClientMessageSchema
>;

export const StoryStartedServerEventSchema = z
  .object({
    type: z.literal("story.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryStartedServerEvent = z.infer<
  typeof StoryStartedServerEventSchema
>;

export const StoryChunkServerEventSchema = z
  .object({
    type: z.literal("story.chunk"),
    requestId: StoryRealtimeRequestIdSchema,
    sequence: z.number().int().positive(),
    delta: z.string().min(1),
  })
  .strict();

export type StoryChunkServerEvent = z.infer<typeof StoryChunkServerEventSchema>;

export const StorySummaryStartedServerEventSchema = z
  .object({
    type: z.literal("story.summary.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StorySummaryStartedServerEvent = z.infer<
  typeof StorySummaryStartedServerEventSchema
>;

export const StoryContextStartedServerEventSchema = z
  .object({
    type: z.literal("story.context.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryContextStartedServerEvent = z.infer<
  typeof StoryContextStartedServerEventSchema
>;

export const StoryCompletedServerEventSchema = z
  .object({
    type: z.literal("story.completed"),
    requestId: StoryRealtimeRequestIdSchema,
    storyline: CompletedStorylineSnapshotSchema,
    generatedSegmentId: StorylineSegmentIdSchema,
  })
  .strict();

export type StoryCompletedServerEvent = z.infer<
  typeof StoryCompletedServerEventSchema
>;

export const StoryCancelledServerEventSchema = z
  .object({
    type: z.literal("story.cancelled"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryCancelledServerEvent = z.infer<
  typeof StoryCancelledServerEventSchema
>;

export const StoryRealtimeErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "INVALID_PAYLOAD",
  "BUSY",
  "NO_ACTIVE_TASK",
  "GENERATION_FAILED",
  "LLM_EMPTY_RESPONSE",
  "LLM_USAGE_MISSING",
  "STORYLINE_NOT_FOUND",
  "STORYLINE_BUSY",
  "STORYLINE_SAVE_FAILED",
  "STORY_SUMMARY_FAILED",
  "STORY_CONTEXT_FAILED",
  "STORY_SEGMENT_NOT_REWRITABLE",
]);

export type StoryRealtimeErrorCode = z.infer<
  typeof StoryRealtimeErrorCodeSchema
>;

export const StoryGenerationPhaseSchema = z.enum([
  "preparing",
  "streaming",
  "updatingContext",
  "saving",
]);

export type StoryGenerationPhase = z.infer<typeof StoryGenerationPhaseSchema>;

export const StoryGenerationTaskStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type StoryGenerationTaskStatus = z.infer<
  typeof StoryGenerationTaskStatusSchema
>;

export const StoryGenerationModeSchema = z.enum([
  "create",
  "append",
  "rewrite",
  "dialogue",
]);

export type StoryGenerationMode = z.infer<typeof StoryGenerationModeSchema>;

export const StoryGenerationTaskSchema = z
  .object({
    status: StoryGenerationTaskStatusSchema,
    phase: StoryGenerationPhaseSchema.optional(),
    mode: StoryGenerationModeSchema,
    requestId: StoryRealtimeRequestIdSchema,
    storylineId: StorylineIdSchema.optional(),
    generatedSegmentId: StorylineSegmentIdSchema.optional(),
    errorCode: StoryRealtimeErrorCodeSchema.optional(),
    message: z.string().min(1).optional(),
  })
  .strict();

export type StoryGenerationTask = z.infer<typeof StoryGenerationTaskSchema>;

export const StoryGenerationStatusResponseSchema = z
  .object({
    task: StoryGenerationTaskSchema.nullable(),
  })
  .strict();

export type StoryGenerationStatusResponse = z.infer<
  typeof StoryGenerationStatusResponseSchema
>;

export const CancelStoryGenerationResponseSchema = z
  .object({
    cancelled: z.boolean(),
    task: StoryGenerationTaskSchema.nullable(),
  })
  .strict();

export type CancelStoryGenerationResponse = z.infer<
  typeof CancelStoryGenerationResponseSchema
>;

export const StoryErrorServerEventSchema = z
  .object({
    type: z.literal("story.error"),
    requestId: z.string(),
    code: StoryRealtimeErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type StoryErrorServerEvent = z.infer<typeof StoryErrorServerEventSchema>;

export const StoryRealtimeServerEventSchema = z.discriminatedUnion("type", [
  StoryStartedServerEventSchema,
  StoryChunkServerEventSchema,
  StorySummaryStartedServerEventSchema,
  StoryContextStartedServerEventSchema,
  StoryCompletedServerEventSchema,
  StoryCancelledServerEventSchema,
  StoryErrorServerEventSchema,
]);

export type StoryRealtimeServerEvent = z.infer<
  typeof StoryRealtimeServerEventSchema
>;
