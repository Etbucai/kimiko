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
  StorylineGenerationMode,
} from "@kimiko/schema";
import { ContinueStoryRequestSchema } from "@kimiko/schema";
import { LlmService } from "../llm/llm.service";
import type { StoryCharacterSummarySnapshot } from "../storyline/storyline-summary.types";

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

export const STORY_DIALOGUE_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责在故事线当前场景中生成一次轻量互动。",
  "用户输入可能是一句角色台词，也可能是一段角色动作描写。",
  "你必须把用户输入润色进最终正文，不要原样机械复制。",
  "你需要从当前场景中寻找另一个合适角色作出回应。",
  "回复角色必须不同于用户输入中的发起角色。",
  "如果当前场景没有合适的另一个角色，只输出“无事发生”。",
  "如果有多个合适角色，只选择一个。",
  "输出 1-2 句短反应，整体建议 20-120 个中文字符。",
  "角色台词要口语化，正常人聊天一句话通常在 5-25 字。",
  "优先采用动作或神态加一句口语回应。",
  "不要继续推进大段新剧情。",
  "不要输出标题、解释、列表、JSON、调试信息或“以下是互动”等前缀。",
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
  readonly generationMode: StorylineGenerationMode;
  readonly instruction: string;
  readonly generatedText: string;
}

export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly historyRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}

export interface StoryRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInstruction: string;
  readonly originalGeneratedText: string;
  readonly initialStoryText?: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly historyRoundsBeforeTarget: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}

export interface StoryDialogueLlmContext {
  readonly input: string;
  readonly currentSceneText: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}

export interface StoryDialogueRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInput: string;
  readonly originalGeneratedText: string;
  readonly currentSceneText: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly recentHistoryRoundsBeforeTarget: readonly StoryHistoryRound[];
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

  async *streamRewriteStoryFromContext(
    context: StoryRewriteLlmContext,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    yield* this.streamStoryLlmRequest(
      buildRewriteStoryLlmRequestFromContext(context),
      options,
    );
  }

  async *streamDialogueStoryFromContext(
    context: StoryDialogueLlmContext,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    yield* this.streamStoryLlmRequest(
      buildDialogueStoryLlmRequestFromContext(context),
      options,
    );
  }

  async *streamRewriteDialogueFromContext(
    context: StoryDialogueRewriteLlmContext,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    yield* this.streamStoryLlmRequest(
      buildRewriteDialogueLlmRequestFromContext(context),
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

export function buildRewriteStoryLlmRequestFromContext(
  context: StoryRewriteLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_SYSTEM_PROMPT,
    userPrompt: buildRewriteStoryUserPromptFromContext(context),
  };
}

export function buildDialogueStoryLlmRequestFromContext(
  context: StoryDialogueLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_DIALOGUE_SYSTEM_PROMPT,
    userPrompt: buildDialogueStoryUserPromptFromContext(context),
  };
}

export function buildRewriteDialogueLlmRequestFromContext(
  context: StoryDialogueRewriteLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_DIALOGUE_SYSTEM_PROMPT,
    userPrompt: buildRewriteDialogueUserPromptFromContext(context),
  };
}

function buildStoryUserPromptFromContext(context: StoryLlmContext): string {
  const promptParts: string[] = [];
  const characterSummaryText = formatCharacterSummary(context.characterSummary);
  const initialStoryText = context.initialStoryText?.trim();

  if (characterSummaryText !== undefined) {
    promptParts.push("角色摘要：", characterSummaryText, "");
  }

  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("故事正文：", initialStoryText, "");
  }

  if (context.historyRounds.length > 0) {
    promptParts.push(
      context.historyWasTrimmed ? "近期故事正文片段：" : "近期生成轨迹：",
    );

    for (const round of context.historyRounds) {
      if (context.historyWasTrimmed) {
        promptParts.push(formatRoundTextLabel(round), round.generatedText, "");
      } else {
        promptParts.push(
          formatRoundInstructionLabel(round),
          round.instruction,
          "",
          formatRoundTextLabel(round),
          round.generatedText,
          "",
        );
      }
    }

    if (context.historyWasTrimmed) {
      promptParts.push("近期生成指令轨迹：");
      for (const round of context.historyRounds) {
        promptParts.push(
          formatRoundInstructionLabel(round),
          round.instruction,
          "",
        );
      }
    }
  }

  promptParts.push("当前续写指令：", context.currentInstruction);

  return promptParts.join("\n");
}

function buildRewriteStoryUserPromptFromContext(
  context: StoryRewriteLlmContext,
): string {
  const promptParts: string[] = [];
  const characterSummaryText = formatCharacterSummary(context.characterSummary);
  const initialStoryText = context.initialStoryText?.trim();

  if (characterSummaryText !== undefined) {
    promptParts.push("角色摘要：", characterSummaryText, "");
  }

  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("故事正文：", initialStoryText, "");
  }

  if (context.historyRoundsBeforeTarget.length > 0) {
    promptParts.push(
      context.historyWasTrimmed
        ? "目标段之前的近期故事正文片段："
        : "目标段之前的近期生成轨迹：",
    );

    for (const round of context.historyRoundsBeforeTarget) {
      if (context.historyWasTrimmed) {
        promptParts.push(formatRoundTextLabel(round), round.generatedText, "");
      } else {
        promptParts.push(
          formatRoundInstructionLabel(round),
          round.instruction,
          "",
          formatRoundTextLabel(round),
          round.generatedText,
          "",
        );
      }
    }

    if (context.historyWasTrimmed) {
      promptParts.push("目标段之前的近期生成指令轨迹：");
      for (const round of context.historyRoundsBeforeTarget) {
        promptParts.push(
          formatRoundInstructionLabel(round),
          round.instruction,
          "",
        );
      }
    }
  }

  promptParts.push(
    "原续写指令：",
    context.originalInstruction,
    "",
    "原生成正文：",
    context.originalGeneratedText,
    "",
    "重写指令：",
    context.rewriteInstruction,
    "",
    "请只输出用于替换原生成正文的新正文。",
    "不要输出初始故事正文，不要重复原生成正文，不要继续写目标段之后的新剧情。",
    "新正文必须承接目标段之前的上下文，可以保留原生成正文中仍合理的部分，但必须优先服从重写指令。",
  );

  return promptParts.join("\n");
}

function buildDialogueStoryUserPromptFromContext(
  context: StoryDialogueLlmContext,
): string {
  const promptParts: string[] = [];
  const characterSummaryText = formatCharacterSummary(context.characterSummary);

  if (characterSummaryText !== undefined) {
    promptParts.push("角色摘要：", characterSummaryText, "");
  }

  promptParts.push("当前场景：", context.currentSceneText, "");

  appendRecentHistoryPrompt({
    historyLabel: context.historyWasTrimmed
      ? "近期故事正文片段："
      : "近期生成轨迹：",
    historyWasTrimmed: context.historyWasTrimmed,
    promptParts,
    rounds: context.recentHistoryRounds,
    trimmedInstructionLabel: "近期生成指令轨迹：",
  });

  promptParts.push(
    "本轮互动输入：",
    context.input,
    "",
    "请只输出本轮互动正文。",
    "如果当前场景没有另一个合适角色可以回应，只输出“无事发生”。",
  );

  return promptParts.join("\n");
}

function buildRewriteDialogueUserPromptFromContext(
  context: StoryDialogueRewriteLlmContext,
): string {
  const promptParts: string[] = [];
  const characterSummaryText = formatCharacterSummary(context.characterSummary);

  if (characterSummaryText !== undefined) {
    promptParts.push("角色摘要：", characterSummaryText, "");
  }

  promptParts.push("当前场景：", context.currentSceneText, "");

  appendRecentHistoryPrompt({
    historyLabel: context.historyWasTrimmed
      ? "目标互动之前的近期故事正文片段："
      : "目标互动之前的近期生成轨迹：",
    historyWasTrimmed: context.historyWasTrimmed,
    promptParts,
    rounds: context.recentHistoryRoundsBeforeTarget,
    trimmedInstructionLabel: "目标互动之前的近期生成指令轨迹：",
  });

  promptParts.push(
    "原互动输入：",
    context.originalInput,
    "",
    "原互动正文：",
    context.originalGeneratedText,
    "",
    "重写要求：",
    context.rewriteInstruction,
    "",
    "请只输出用于替换原互动正文的新互动正文。",
    "新正文仍然必须是轻量互动，不要扩写成大段续写。",
    "如果重写后当前场景仍没有另一个合适角色可以回应，可以只输出“无事发生”。",
  );

  return promptParts.join("\n");
}

function appendRecentHistoryPrompt(input: {
  readonly historyLabel: string;
  readonly historyWasTrimmed: boolean;
  readonly promptParts: string[];
  readonly rounds: readonly StoryHistoryRound[];
  readonly trimmedInstructionLabel: string;
}): void {
  if (input.rounds.length === 0) {
    return;
  }

  input.promptParts.push(input.historyLabel);

  for (const round of input.rounds) {
    if (input.historyWasTrimmed) {
      input.promptParts.push(
        formatRoundTextLabel(round),
        round.generatedText,
        "",
      );
      continue;
    }

    input.promptParts.push(
      formatRoundInstructionLabel(round),
      round.instruction,
      "",
      formatRoundTextLabel(round),
      round.generatedText,
      "",
    );
  }

  if (!input.historyWasTrimmed) {
    return;
  }

  input.promptParts.push(input.trimmedInstructionLabel);
  for (const round of input.rounds) {
    input.promptParts.push(
      formatRoundInstructionLabel(round),
      round.instruction,
      "",
    );
  }
}

function formatRoundInstructionLabel(round: StoryHistoryRound): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动输入：`
    : `第 ${round.roundIndex} 轮续写指令：`;
}

function formatRoundTextLabel(round: StoryHistoryRound): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动正文：`
    : `第 ${round.roundIndex} 轮续写正文：`;
}

function formatCharacterSummary(
  characterSummary: StoryCharacterSummarySnapshot | undefined,
): string | undefined {
  if (
    characterSummary === undefined ||
    characterSummary.characters.length === 0
  ) {
    return undefined;
  }

  return JSON.stringify(characterSummary, null, 2);
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
