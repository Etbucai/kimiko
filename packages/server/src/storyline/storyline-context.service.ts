import { Injectable } from "@nestjs/common";
import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { LlmService } from "../llm/llm.service";
import { StoryContextFailedError } from "./storyline.errors";
import {
  emptyStoryContextSnapshot,
  STORY_CONTEXT_LIMITS,
  StoryContextDraftSnapshotSchema,
  type GenerateStoryContextInput,
  type StoryContextDraftSnapshot,
  type StoryContextOperation,
} from "./storyline-context.types";

export const STORY_CONTEXT_SYSTEM_PROMPT = [
  "你是 StoryAgent 的故事上下文维护器。",
  "你只负责维护结构化故事上下文，不负责续写正文。",
  "你必须只输出 JSON，不输出解释、Markdown 或额外文本。",
  "你只能根据输入中的旧故事上下文、来源列表、历史片段、当前指令和本轮正文更新上下文。",
  "不要创造输入中没有依据的新事实。",
  "不要主动制造错误记忆；只有正文明确表现角色误解时，才记录 false belief。",
  "输出必须符合 StoryContextDraftSnapshot JSON schema。",
].join("\n");

@Injectable()
export class StorylineContextService {
  constructor(private readonly llmService: LlmService) {}

  async generateStoryContextDraft(
    input: GenerateStoryContextInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<StoryContextDraftSnapshot> {
    try {
      assertNotAborted(options.signal);
      const response = await this.llmService.generateTextFromParsedRequest(
        buildStoryContextLlmRequest(input),
        options,
      );
      assertNotAborted(options.signal);
      return parseStoryContextDraftResponse(response.text);
    } catch (error: unknown) {
      if (options.signal.aborted) {
        throw error;
      }

      if (error instanceof StoryContextFailedError) {
        throw error;
      }

      throw new StoryContextFailedError(toErrorMessage(error));
    }
  }
}

export function buildStoryContextLlmRequest(
  input: GenerateStoryContextInput,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_CONTEXT_SYSTEM_PROMPT,
    userPrompt: buildStoryContextUserPrompt(input),
  };
}

export function parseStoryContextDraftResponse(
  value: string,
): StoryContextDraftSnapshot {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new StoryContextFailedError("Context response is empty");
  }

  if (!normalizedValue.startsWith("{") || !normalizedValue.endsWith("}")) {
    throw new StoryContextFailedError("Context response must be pure JSON");
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(normalizedValue) as unknown;
  } catch (error: unknown) {
    throw new StoryContextFailedError(toErrorMessage(error));
  }

  const result = StoryContextDraftSnapshotSchema.safeParse(parsedValue);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new StoryContextFailedError(
      firstIssue?.message ?? "Context draft schema is invalid",
    );
  }

  return result.data;
}

function buildStoryContextUserPrompt(input: GenerateStoryContextInput): string {
  const promptParts: string[] = [
    "请维护当前故事线的 StoryContextDraftSnapshot。",
    "",
    "输出 JSON schema 说明：",
    getDraftSchemaDescription(),
    "",
    "数量上限：",
    stringifyPromptJson(STORY_CONTEXT_LIMITS),
    "",
    "可用来源 sourceRefs：",
  ];

  for (const source of input.sourceRefMappings) {
    promptParts.push(`- ${source.ref}：${source.label}`);
  }

  promptParts.push(
    "",
    "旧故事上下文：",
    stringifyPromptJson(input.previousContext ?? emptyStoryContextSnapshot),
    "",
  );

  const initialStoryText = input.initialStoryText?.trim();
  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("初始故事正文：", initialStoryText, "");
  }

  if (input.recentHistoryRounds.length > 0) {
    promptParts.push("近期故事上下文：");
    for (const round of input.recentHistoryRounds) {
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

  promptParts.push(
    "本轮操作：",
    getOperationLabel(input.operation),
    "",
    getInstructionLabel(input.operation),
    input.currentInstruction,
    "",
    getGeneratedTextLabel(input.operation),
    input.generatedText,
    "",
    "输出要求：",
    "- 只输出 JSON。",
    "- draft 中 existingId 可以引用旧 context 中已有的 char_N / fact_N。",
    "- draftKey 用于本轮新增角色或事实，后续 refs 可以引用它。",
    "- sourceRefs 只能使用上方列出的来源。",
    "- 所有事实、角色、belief、opinion、relationship 都必须有 sourceRefs。",
    "- 不要创造输入中没有依据的新事实。",
    "- 不要主动制造错误记忆；只有正文明确表现角色误解时，才记录 truthStatus 为 false 的 belief。",
  );

  return promptParts.join("\n");
}

function getDraftSchemaDescription(): string {
  return [
    "{",
    '  "worldFacts": [',
    "    {",
    '      "existingId": "可选，旧 fact_N",',
    '      "draftKey": "可选，本轮新增事实临时 key",',
    '      "kind": "event | setting | environment | relationship | status | term",',
    '      "text": "事实文本",',
    '      "status": "active | resolved",',
    '      "visibility": "observable | public | hidden",',
    '      "sourceRefs": ["initial | current | segment:<id>"]',
    "    }",
    "  ],",
    '  "characters": [',
    "    {",
    '      "existingId": "可选，旧 char_N",',
    '      "draftKey": "可选，本轮新增角色临时 key",',
    '      "name": "角色名",',
    '      "aliases": ["别名"],',
    '      "identity": "身份",',
    '      "traits": ["性格/特征"],',
    '      "relationships": [{ "targetCharacterRefs": ["char_N 或 draftKey"], "text": "关系", "sourceRefs": ["来源"] }],',
    '      "motivations": ["动机"],',
    '      "currentStatus": "当前状态",',
    '      "beliefs": [{ "text": "认知", "truthStatus": "true | false | unknown", "factRefs": ["fact_N 或 draftKey"], "sourceRefs": ["来源"] }],',
    '      "opinions": [{ "target": "目标", "text": "观点", "sourceRefs": ["来源"] }],',
    '      "actionTendencies": ["行动倾向"],',
    '      "sourceRefs": ["来源"]',
    "    }",
    "  ],",
    '  "currentScene": {',
    '    "location": "地点",',
    '    "timeLabel": "时间或阶段",',
    '    "presentCharacterRefs": ["char_N 或 draftKey"],',
    '    "observableFactRefs": ["fact_N 或 draftKey"],',
    '    "sceneStatus": "场景状态",',
    '    "sourceRefs": ["来源"]',
    "  }",
    "}",
  ].join("\n");
}

function getOperationLabel(operation: StoryContextOperation): string {
  switch (operation) {
    case "create":
      return "新建故事线";
    case "append":
      return "续写";
    case "rewrite":
      return "重写";
    case "dialogue":
      return "互动";
  }
}

function getInstructionLabel(operation: StoryContextOperation): string {
  switch (operation) {
    case "create":
    case "append":
      return "本轮续写指令：";
    case "rewrite":
      return "本轮重写指令：";
    case "dialogue":
      return "本轮互动输入：";
  }
}

function getGeneratedTextLabel(operation: StoryContextOperation): string {
  return operation === "dialogue" ? "本轮互动正文：" : "本轮生成正文：";
}

function formatRoundInstructionLabel(
  round: GenerateStoryContextInput["recentHistoryRounds"][number],
): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动输入：`
    : `第 ${round.roundIndex} 轮续写指令：`;
}

function formatRoundTextLabel(
  round: GenerateStoryContextInput["recentHistoryRounds"][number],
): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动正文：`
    : `第 ${round.roundIndex} 轮续写正文：`;
}

function stringifyPromptJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Story context generation was aborted");
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
