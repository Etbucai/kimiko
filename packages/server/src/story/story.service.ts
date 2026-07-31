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
  StoryCharacterContext,
  StoryContextSnapshot,
  StoryWorldFact,
  StorylineGenerationMode,
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

const STORY_SYSTEM_PROMPT_PREFIX = [
  "你是 StoryAgent，负责根据用户提供的故事正文和续写指令生成故事续写。",
  "你擅长使用日本hentai小说的文风，负责把用户的提纲扩写成文字段落，写出角色的心理、动作、话语。着重描写角色的神情，体态和衣着。扩写时，如果没有额外要求，请不要跳步，大幅度跳跃时间，随意的更换场景。请不要输出重复的情节和段落。文风请多用自然和符合人物特质的词句，禁止过多堆砌不必要的词藻。之后所有生成的文字都需要遵照这些的要求。读者受教育程度低，缺乏理化生知识和数学概念；读者喜欢看行文流畅、节奏紧凑、审美低俗的男频网络小说；读者的审美充满男性凝视，喜欢女性的外貌描写和身体特写，对女性有强烈的物化或性化倾向。",
  "你必须只输出新生成的续写正文，不要重复用户输入的故事正文。",
  "续写正文需要承接原文已有的人物、事件、语气和上下文。",
  "续写正文需要遵循用户的续写指令，体现主要情节和人物行动。",
] as const;

const STORY_SYSTEM_PROMPT_SUFFIX = [
  "输出语言必须跟随故事正文的主要语言。",
  "不要输出标题、解释、列表、调试信息或“以下是续写”等前缀。",
] as const;

export function buildStorySystemPrompt(targetLength?: number): string {
  return [
    ...STORY_SYSTEM_PROMPT_PREFIX,
    targetLength === undefined
      ? "输出目标长度为 800-1200 字。"
      : `输出目标长度约 ${targetLength} 字，允许合理浮动。`,
    ...STORY_SYSTEM_PROMPT_SUFFIX,
  ].join("\n");
}

export const STORY_SYSTEM_PROMPT = buildStorySystemPrompt();

export const STORY_DIALOGUE_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责在故事线当前场景中生成一次轻量互动。",
  "用户输入可能是一句角色台词，也可能是一段角色动作描写。",
  "最终输出必须同时包含两部分：先把用户输入润色成故事正文，再写另一个角色的互动反应。",
  "不要只输出另一角色的回应；如果缺少用户输入的润色版本，本次输出就是错误的。",
  "润色用户输入时不要原样机械复制，但必须保留用户输入表达的角色、动作或台词意图。",
  "你需要从当前场景中寻找另一个合适角色作出回应。",
  "回复角色必须不同于用户输入中的发起角色。",
  "如果当前场景没有合适的另一个角色，只输出“无事发生”。",
  "如果有多个合适角色，只选择一个。",
  "输出 3-4 句短反应，整体建议 120-200 个中文字符。",
  "角色台词要口语化，正常人聊天一句话通常在 5-25 字。",
  "优先采用动作或神态加一句口语回应。",
  "不要继续推进大段新剧情。",
  "不要输出标题、解释、列表、JSON、调试信息或“以下是互动”等前缀。",
].join("\n");

export const STORY_CREATE_FROM_SETTING_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责根据用户提供的故事设定和开场方向生成新故事开端。",
  "设定是创作背景，不是需要逐字复述的正文。",
  "开场方向描述本次故事应该从哪里开始。",
  "你必须只输出新生成的故事正文。",
  "不要输出设定整理、标题、解释、列表、调试信息或“以下是正文”等前缀。",
  "输出语言必须跟随用户开场和设定的主要语言。",
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
  readonly segmentId: string;
  readonly roundIndex: number;
  readonly generationMode: StorylineGenerationMode;
  readonly instruction: string;
  readonly generatedText: string;
}

export interface StoryWriterContextBundle {
  readonly storyContext: StoryContextSnapshot;
  readonly observableFacts: readonly StoryWorldFact[];
  readonly activeCharacters: readonly StoryCharacterContext[];
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
  readonly contextWasMissing: boolean;
}

export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly targetLength?: number;
  readonly contextBundle: StoryWriterContextBundle;
}

export interface StoryRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInstruction: string;
  readonly originalGeneratedText: string;
  readonly initialStoryText?: string;
  readonly targetLength?: number;
  readonly contextBundle: StoryWriterContextBundle;
}

export interface StoryDialogueLlmContext {
  readonly input: string;
  readonly currentSceneText: string;
  readonly contextBundle: StoryWriterContextBundle;
}

export interface StoryDialogueRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInput: string;
  readonly originalGeneratedText: string;
  readonly currentSceneText: string;
  readonly contextBundle: StoryWriterContextBundle;
}

export interface StoryCreateFromSettingLlmContext {
  readonly settingContent: string;
  readonly opening: string;
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

  async *streamCreateStoryFromSetting(
    context: StoryCreateFromSettingLlmContext,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<StoryStreamEvent> {
    yield* this.streamStoryLlmRequest(
      buildCreateFromSettingLlmRequest(context),
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
    systemPrompt: buildStorySystemPrompt(),
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
    systemPrompt: buildStorySystemPrompt(context.targetLength),
    userPrompt: buildStoryUserPromptFromContext(context),
  };
}

export function buildRewriteStoryLlmRequestFromContext(
  context: StoryRewriteLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: buildStorySystemPrompt(context.targetLength),
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

export function buildCreateFromSettingLlmRequest(
  context: StoryCreateFromSettingLlmContext,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_CREATE_FROM_SETTING_SYSTEM_PROMPT,
    userPrompt: buildCreateFromSettingUserPrompt(context),
  };
}

function buildStoryUserPromptFromContext(context: StoryLlmContext): string {
  const promptParts: string[] = [];
  const initialStoryText = context.initialStoryText?.trim();

  appendStoryContextPrompt(promptParts, context.contextBundle);

  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("故事正文：", initialStoryText, "");
  }

  appendRecentHistoryPrompt({
    historyLabel: context.contextBundle.historyWasTrimmed
      ? "近期故事正文片段（只作叙事承接参考，不代表任何角色知道其中全部信息）："
      : "近期生成轨迹（只作叙事承接参考，不代表任何角色知道其中全部信息）：",
    historyWasTrimmed: context.contextBundle.historyWasTrimmed,
    promptParts,
    rounds: context.contextBundle.recentHistoryRounds,
    trimmedInstructionLabel: "近期生成指令轨迹：",
  });

  promptParts.push("当前续写指令：", context.currentInstruction);

  return promptParts.join("\n");
}

function buildCreateFromSettingUserPrompt(
  context: StoryCreateFromSettingLlmContext,
): string {
  return [
    "故事设定：",
    context.settingContent,
    "",
    "开场方向：",
    context.opening,
    "",
    "请基于设定和开场方向，生成新故事的开端正文。",
  ].join("\n");
}

function buildRewriteStoryUserPromptFromContext(
  context: StoryRewriteLlmContext,
): string {
  const promptParts: string[] = [];
  const initialStoryText = context.initialStoryText?.trim();

  appendStoryContextPrompt(promptParts, context.contextBundle);

  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("故事正文：", initialStoryText, "");
  }

  appendRecentHistoryPrompt({
    historyLabel: context.contextBundle.historyWasTrimmed
      ? "目标段之前的近期故事正文片段（只作叙事承接参考，不代表任何角色知道其中全部信息）："
      : "目标段之前的近期生成轨迹（只作叙事承接参考，不代表任何角色知道其中全部信息）：",
    historyWasTrimmed: context.contextBundle.historyWasTrimmed,
    promptParts,
    rounds: context.contextBundle.recentHistoryRounds,
    trimmedInstructionLabel: "目标段之前的近期生成指令轨迹：",
  });

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
    "请输出一整段用于替换原生成正文的新正文。",
    "新正文会整体替换原生成正文，因此必须从原生成正文开头对应的位置开始写，不能只从需要修改的位置继续写。",
    "如果重写指令只要求修正局部情节，请尽量保留原生成正文中与指令不冲突的大部分内容，只改写冲突或需要优化的部分。",
    "不要输出初始故事正文，不要继续写目标段之后的新剧情。",
    "新正文必须承接目标段之前的上下文，必须优先服从重写指令。",
  );

  return promptParts.join("\n");
}

function buildDialogueStoryUserPromptFromContext(
  context: StoryDialogueLlmContext,
): string {
  const promptParts: string[] = [];

  appendStoryContextPrompt(promptParts, context.contextBundle);

  promptParts.push("当前场景：", context.currentSceneText, "");

  appendRecentHistoryPrompt({
    historyLabel: context.contextBundle.historyWasTrimmed
      ? "近期故事正文片段（只作叙事承接参考，不代表任何角色知道其中全部信息）："
      : "近期生成轨迹（只作叙事承接参考，不代表任何角色知道其中全部信息）：",
    historyWasTrimmed: context.contextBundle.historyWasTrimmed,
    promptParts,
    rounds: context.contextBundle.recentHistoryRounds,
    trimmedInstructionLabel: "近期生成指令轨迹：",
  });

  promptParts.push(
    "本轮互动输入：",
    context.input,
    "",
    "请只输出本轮互动正文。",
    "本轮互动正文必须先呈现用户输入的润色版本，再呈现另一个角色的反应。",
    "不要省略用户输入对应的动作或台词，不要只写另一角色如何回应。",
    "如果当前场景没有另一个合适角色可以回应，只输出“无事发生”。",
  );

  return promptParts.join("\n");
}

function buildRewriteDialogueUserPromptFromContext(
  context: StoryDialogueRewriteLlmContext,
): string {
  const promptParts: string[] = [];

  appendStoryContextPrompt(promptParts, context.contextBundle);

  promptParts.push("当前场景：", context.currentSceneText, "");

  appendRecentHistoryPrompt({
    historyLabel: context.contextBundle.historyWasTrimmed
      ? "目标互动之前的近期故事正文片段（只作叙事承接参考，不代表任何角色知道其中全部信息）："
      : "目标互动之前的近期生成轨迹（只作叙事承接参考，不代表任何角色知道其中全部信息）：",
    historyWasTrimmed: context.contextBundle.historyWasTrimmed,
    promptParts,
    rounds: context.contextBundle.recentHistoryRounds,
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
    "新互动正文必须同时包含原互动输入的润色版本和另一个角色的反应。",
    "不要只输出另一角色的回应；如果缺少原互动输入对应的动作或台词，本次输出就是错误的。",
    "新正文仍然必须是轻量互动，不要扩写成大段续写。",
    "如果重写后当前场景仍没有另一个合适角色可以回应，可以只输出“无事发生”。",
  );

  return promptParts.join("\n");
}

function appendStoryContextPrompt(
  promptParts: string[],
  contextBundle: StoryWriterContextBundle,
): void {
  if (contextBundle.contextWasMissing) {
    promptParts.push(
      "故事上下文：",
      "当前没有可用的结构化故事上下文。请优先承接初始正文和近期正文轨迹。",
      "",
    );
    return;
  }

  promptParts.push(
    "当前可观察世界事实：",
    contextBundle.observableFacts.length === 0
      ? "无明确可观察事实。"
      : contextBundle.observableFacts
          .map(
            (fact, index) =>
              `${index + 1}. [${fact.id}][${fact.kind}][${fact.visibility}][${fact.status}] ${fact.text}`,
          )
          .join("\n"),
    "",
  );

  promptParts.push("活跃角色认知：");
  if (contextBundle.activeCharacters.length === 0) {
    promptParts.push("无明确活跃角色认知。", "");
  } else {
    for (const character of contextBundle.activeCharacters) {
      promptParts.push(formatCharacterContext(character), "");
    }
  }

  promptParts.push(
    "角色行动约束：",
    "写某个角色的行动、台词和心理时，只能使用该角色自己的认知，以及当前可观察世界事实。",
    "不要让角色使用其它角色独有的认知。",
    "不要让角色使用未出现在“当前可观察世界事实”中的隐藏事实。",
    "近期正文轨迹只用于承接语气和动作，不代表所有角色都知道其中信息。",
    "如果角色认知与世界事实冲突，角色可以按错误认知行动，但环境反馈按世界事实成立。",
    "",
  );
}

function formatCharacterContext(character: StoryCharacterContext): string {
  const lines = [
    `角色 [${character.id}] ${character.name}`,
    character.aliases.length > 0
      ? `- 别名：${character.aliases.join("、")}`
      : undefined,
    character.identity.length > 0 ? `- 身份：${character.identity}` : undefined,
    character.currentStatus.length > 0
      ? `- 当前状态：${character.currentStatus}`
      : undefined,
    character.traits.length > 0
      ? `- 特征：${character.traits.join("；")}`
      : undefined,
    character.motivations.length > 0
      ? `- 动机：${character.motivations.join("；")}`
      : undefined,
    character.relationships.length > 0
      ? [
          "- 关系：",
          ...character.relationships.map(
            (relationship) =>
              `  - 对 ${relationship.targetCharacterId}：${relationship.text}`,
          ),
        ].join("\n")
      : undefined,
    character.beliefs.length > 0
      ? [
          "- 已知/相信：",
          ...character.beliefs.map((belief) =>
            [
              `  - [${belief.truthStatus}] ${belief.text}`,
              belief.factIds.length > 0
                ? `（关联事实：${belief.factIds.join("、")}）`
                : "",
            ].join(""),
          ),
        ].join("\n")
      : undefined,
    character.opinions.length > 0
      ? [
          "- 主观意见：",
          ...character.opinions.map(
            (opinion) => `  - 对 ${opinion.target}：${opinion.text}`,
          ),
        ].join("\n")
      : undefined,
    character.actionTendencies.length > 0
      ? `- 行动倾向：${character.actionTendencies.join("；")}`
      : undefined,
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
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
