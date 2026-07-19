import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import type {
  ContinueStoryRequest,
  ContinueStoryResponse,
  ContinueStoryUsage,
  GenerateLlmTextRequest,
  GenerateLlmTextUsage,
} from "@kimiko/schema";
import { ContinueStoryRequestSchema } from "@kimiko/schema";
import { LlmService } from "../llm/llm.service";

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

export const STORY_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责根据用户提供的故事正文和续写指令生成故事续写。",
  "你必须只输出新生成的续写正文，不要重复用户输入的故事正文。",
  "续写正文需要承接原文已有的人物、事件、语气和上下文。",
  "续写正文需要遵循用户的续写指令，体现主要情节和人物行动。",
  "输出目标长度为 800-1200 字。",
  "输出语言必须跟随故事正文的主要语言。",
  "不要输出标题、解释、列表、调试信息或“以下是续写”等前缀。",
].join("\n");

@Injectable()
export class StoryService {
  constructor(private readonly llmService: LlmService) {}

  async continueStory(body: unknown): Promise<ContinueStoryResponse> {
    const request = parseRequest<ContinueStoryRequest>(
      ContinueStoryRequestSchema.safeParse(body),
    );
    const llmRequest = buildStoryLlmRequest(request);

    const startedAt = Date.now();
    const llmResponse =
      await this.llmService.generateTextFromParsedRequest(llmRequest);
    const elapsedMs = Math.max(0, Date.now() - startedAt);

    const continuedStory = normalizeGeneratedStory(llmResponse.text);
    const model = normalizeModel(llmResponse.model);
    const usage = parseCompleteUsage(llmResponse.usage);

    return {
      continuedStory,
      model,
      elapsedMs,
      usage,
    };
  }
}

export function buildStoryLlmRequest(
  request: ContinueStoryRequest,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_SYSTEM_PROMPT,
    userPrompt: buildStoryUserPrompt(request),
  };
}

function buildStoryUserPrompt(request: ContinueStoryRequest): string {
  return [
    "故事正文：",
    request.storyText,
    "",
    "续写指令：",
    request.instruction,
  ].join("\n");
}

function normalizeGeneratedStory(value: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new BadGatewayException("LLM provider returned an empty story");
  }

  return normalizedValue;
}

function normalizeModel(value: string): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new BadGatewayException("LLM provider returned an empty model");
  }

  return normalizedValue;
}

function parseCompleteUsage(
  usage: GenerateLlmTextUsage | undefined,
): ContinueStoryUsage {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const totalTokens = usage?.totalTokens;

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    throw new BadGatewayException("LLM provider returned incomplete token usage");
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
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
