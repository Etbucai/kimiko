import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import { GenerateLlmTextRequestSchema } from "@kimiko/schema";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmTextStreamEvent,
} from "./llm.provider";

type SchemaParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{
      success: false;
      error: {
        issues: readonly {
          path: readonly PropertyKey[];
          message: string;
        }[];
      };
    }>;

@Injectable()
export class LlmService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llmProvider: LlmProvider,
  ) {}

  async generateText(body: unknown): Promise<GenerateLlmTextResponse> {
    const request = parseRequest<GenerateLlmTextRequest>(
      GenerateLlmTextRequestSchema.safeParse(body),
    );

    return this.generateTextFromParsedRequest(request);
  }

  async generateTextFromParsedRequest(
    request: GenerateLlmTextRequest,
  ): Promise<GenerateLlmTextResponse> {
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);

    return this.llmProvider.generateText({
      userPrompt: request.userPrompt.trim(),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });
  }

  streamTextFromParsedRequest(
    request: GenerateLlmTextRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<LlmTextStreamEvent> {
    const systemPrompt = normalizeOptionalPrompt(request.systemPrompt);

    return this.llmProvider.streamText(
      {
        userPrompt: request.userPrompt.trim(),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      },
      options,
    );
  }
}

function normalizeOptionalPrompt(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue !== undefined && normalizedValue.length > 0
    ? normalizedValue
    : undefined;
}

function parseRequest<T>(result: SchemaParseResult<T>): T {
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  if (firstIssue === undefined) {
    throw new BadRequestException("Request body is invalid");
  }

  const fieldPath = firstIssue.path.map(String).join(".");
  const prefix = fieldPath.length > 0 ? `${fieldPath}: ` : "";
  throw new BadRequestException(`${prefix}${firstIssue.message}`);
}
