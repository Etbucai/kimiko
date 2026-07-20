import { z } from "zod";

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

export type GetMyUserInfoResponse = z.infer<
  typeof GetMyUserInfoResponseSchema
>;

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

export type RefreshTokenResponse = z.infer<
  typeof RefreshTokenResponseSchema
>;

export const LogoutUserRequestSchema = RefreshTokenRequestSchema;

export type LogoutUserRequest = z.infer<typeof LogoutUserRequestSchema>;

export const LogoutUserResponseSchema = z.object({}).strict();

export type LogoutUserResponse = z.infer<typeof LogoutUserResponseSchema>;

const OptionalPromptSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  },
  z.string().trim().min(1).max(8_000).optional(),
);

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

export type GenerateLlmTextUsage = z.infer<
  typeof GenerateLlmTextUsageSchema
>;

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

export const ContinueStoryRequestSchema = z
  .object({
    storyText: z.string().trim().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type ContinueStoryRequest = z.infer<
  typeof ContinueStoryRequestSchema
>;

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

export type ContinueStoryResponse = z.infer<
  typeof ContinueStoryResponseSchema
>;

export const StoryRealtimeRequestIdSchema = z.string().trim().min(1);

export const StoryContinueClientMessageSchema = z
  .object({
    type: z.literal("story.continue"),
    requestId: StoryRealtimeRequestIdSchema,
    payload: ContinueStoryRequestSchema,
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

export type StoryChunkServerEvent = z.infer<
  typeof StoryChunkServerEventSchema
>;

export const StoryCompletedServerEventSchema = z
  .object({
    type: z.literal("story.completed"),
    requestId: StoryRealtimeRequestIdSchema,
    continuedStory: z.string().trim().min(1),
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
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
]);

export type StoryRealtimeErrorCode = z.infer<
  typeof StoryRealtimeErrorCodeSchema
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

export type StoryErrorServerEvent = z.infer<
  typeof StoryErrorServerEventSchema
>;

export const StoryRealtimeServerEventSchema = z.discriminatedUnion("type", [
  StoryStartedServerEventSchema,
  StoryChunkServerEventSchema,
  StoryCompletedServerEventSchema,
  StoryCancelledServerEventSchema,
  StoryErrorServerEventSchema,
]);

export type StoryRealtimeServerEvent = z.infer<
  typeof StoryRealtimeServerEventSchema
>;
