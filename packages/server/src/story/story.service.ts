import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from "@nestjs/common";
import type {
  ContinueStoryRequest,
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
  "你擅长使用日本hentai小说的文风，负责把用户的提纲扩写成文字段落，写出角色的心理、动作、话语。着重描写角色的神情，体态和衣着。扩写时，如果没有额外要求，请不要跳步，大幅度跳跃时间，随意的更换场景。请不要输出重复的情节和段落。文风请多用自然和符合人物特质的词句，禁止过多堆砌不必要的词藻。之后所有生成的文字都需要遵照这些的要求。读者受教育程度低，缺乏理化生知识和数学概念；读者喜欢看行文流畅、节奏紧凑、审美低俗的男频网络小说；读者的审美充满男性凝视，喜欢女性的外貌描写和身体特写，对女性有强烈的物化或性化倾向。",
  "你必须只输出新生成的续写正文，不要重复用户输入的故事正文。",
  "续写正文需要承接原文已有的人物、事件、语气和上下文。",
  "续写正文需要遵循用户的续写指令，体现主要情节和人物行动。",
  "输出目标长度为 800-1200 字。",
  "输出语言必须跟随故事正文的主要语言。",
  "不要输出标题、解释、列表、调试信息或“以下是续写”等前缀。",
].join("\n");

export type StoryStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{
      type: "completed";
      continuedStory: string;
      model: string;
      elapsedMs: number;
      usage: ContinueStoryUsage;
    }>;

export interface StoryHistoryRound {
  readonly roundIndex: number;
  readonly instruction: string;
  readonly generatedText: string;
}

export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly historyRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}

@Injectable()
export class StoryService {
  constructor(private readonly llmService: LlmService) {}

  async *streamContinueStory(
    body: unknown,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    const request = parseRequest<ContinueStoryRequest>(
      ContinueStoryRequestSchema.safeParse(body),
    );
    const llmRequest = buildStoryLlmRequest(request);

    yield* this.streamStoryLlmRequest(llmRequest, options);
  }

  async *streamContinueStoryFromContext(
    context: StoryLlmContext,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    yield* this.streamStoryLlmRequest(
      buildStoryLlmRequestFromContext(context),
      options,
    );
  }

  private async *streamStoryLlmRequest(
    llmRequest: GenerateLlmTextRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    const startedAt = Date.now();
    let continuedStory = "";
    let sequence = 0;

    for await (const event of this.llmService.streamTextFromParsedRequest(
      llmRequest,
      options,
    )) {
      if (event.type === "chunk") {
        if (event.delta.length === 0) {
          continue;
        }

        sequence += 1;
        continuedStory += event.delta;
        yield {
          type: "chunk",
          delta: event.delta,
          sequence,
        };
        continue;
      }

      const normalizedStory = normalizeGeneratedStory(continuedStory);
      const model = normalizeModel(event.model);
      const usage = parseCompleteUsage(event.usage);

      yield {
        type: "completed",
        continuedStory: normalizedStory,
        model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        usage,
      };
    }
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

export function buildStoryLlmRequestFromContext(
  context: StoryLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_SYSTEM_PROMPT,
    userPrompt: buildStoryUserPromptFromContext(context),
  };
}

function buildStoryUserPromptFromContext(context: StoryLlmContext): string {
  const promptParts: string[] = [];
  const initialStoryText = context.initialStoryText?.trim();

  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("故事正文：", initialStoryText, "");
  }

  if (context.historyRounds.length > 0) {
    promptParts.push(
      context.historyWasTrimmed ? "近期故事正文片段：" : "近期续写轨迹：",
    );

    for (const round of context.historyRounds) {
      if (context.historyWasTrimmed) {
        promptParts.push(
          `第 ${round.roundIndex} 轮续写：`,
          round.generatedText,
          "",
        );
      } else {
        promptParts.push(
          `第 ${round.roundIndex} 轮指令：`,
          round.instruction,
          "",
          `第 ${round.roundIndex} 轮续写：`,
          round.generatedText,
          "",
        );
      }
    }

    if (context.historyWasTrimmed) {
      promptParts.push("近期续写指令轨迹：");
      for (const round of context.historyRounds) {
        promptParts.push(`第 ${round.roundIndex} 轮指令：`, round.instruction, "");
      }
    }
  }

  promptParts.push("当前续写指令：", context.currentInstruction);

  return promptParts.join("\n");
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
    throw new BadGatewayException(
      "LLM provider returned incomplete token usage",
    );
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
