import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import { GenerateLlmTextRequestSchema } from "@kimiko/schema";
import { LLM_PROVIDER, type LlmProvider } from "./llm.provider";

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

    return this.llmProvider.generateText({
      userPrompt: request.userPrompt,
      ...(request.systemPrompt !== undefined
        ? { systemPrompt: request.systemPrompt }
        : {}),
    });
  }
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
