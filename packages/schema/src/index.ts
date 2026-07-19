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
