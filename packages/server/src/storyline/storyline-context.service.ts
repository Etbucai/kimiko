import { Injectable } from "@nestjs/common";
import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { LlmService } from "../llm/llm.service";
import { StoryContextFailedError } from "./storyline.errors";
import {
  emptyStoryContextSnapshot,
  type StoryContextOperation,
} from "./storyline-context.types";
import {
  StoryContextPatchDraftSchema,
  type GenerateStoryContextPatchInput,
  type StoryContextPatchDraft,
} from "./storyline-context-patch.types";
import { repairStoryContextPatchValue } from "./storyline-context-patch-repair";

export const STORY_CONTEXT_SYSTEM_PROMPT = [
  "你是 StoryAgent 的故事上下文增量维护器。",
  "你只负责输出相对旧故事上下文的 StoryContextPatchDraft，不负责续写正文。",
  "你必须只输出单行 JSON，不要换行、缩进、解释、Markdown 或额外文本。",
  "不要重复输出旧 context 中未变化的事实、角色、认知或关系。",
  "你只能根据输入中的旧故事上下文、来源列表、历史片段、当前指令和本轮正文生成 patch。",
  "输入可能包含多轮尚未提取的历史片段；必须综合这些片段和本轮正文更新 context。",
  "不要创造输入中没有依据的新事实。",
  "不要主动制造错误记忆；只有正文明确表现角色误解时，才记录 false belief。",
  "输出必须符合 StoryContextPatchDraft JSON schema。",
].join("\n");

export const STORY_CONTEXT_REPAIR_SYSTEM_PROMPT = [
  "你是 StoryAgent 的 context patch JSON 修复器。",
  "你只负责修复一份已经生成的 StoryContextPatchDraft JSON。",
  "你必须只输出修复后的单行 JSON，不要换行、缩进、解释、Markdown 或额外文本。",
  "不要输出完整 StoryContextSnapshot。",
  "你不得新增、删除或改写故事事实；只能做满足 JSON 格式和 schema 的最小 patch 修复。",
  "如果字段取值无法确定，使用 schema 允许的保守值。",
].join("\n");

@Injectable()
export class StorylineContextService {
  constructor(private readonly llmService: LlmService) {}

  async generateStoryContextPatch(
    input: GenerateStoryContextPatchInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<StoryContextPatchDraft> {
    try {
      assertNotAborted(options.signal);
      const response = await this.llmService.generateTextFromParsedRequest(
        buildStoryContextLlmRequest(input),
        options,
      );
      assertNotAborted(options.signal);
      const parsedPatch = parseStoryContextPatchResponse(response.text);
      if (parsedPatch.success) {
        return parsedPatch.patch;
      }

      return await this.repairStoryContextPatch(
        {
          errorMessage: parsedPatch.message,
          input,
          invalidResponse: response.text,
        },
        options,
      );
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

  private async repairStoryContextPatch(
    input: Readonly<{
      errorMessage: string;
      input: GenerateStoryContextPatchInput;
      invalidResponse: string;
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<StoryContextPatchDraft> {
    assertNotAborted(options.signal);
    const response = await this.llmService.generateTextFromParsedRequest(
      buildStoryContextRepairLlmRequest(input),
      options,
    );
    assertNotAborted(options.signal);
    const parsedPatch = parseStoryContextPatchResponse(response.text);
    if (parsedPatch.success) {
      return parsedPatch.patch;
    }

    throw new StoryContextFailedError(parsedPatch.message);
  }
}

export function buildStoryContextLlmRequest(
  input: GenerateStoryContextPatchInput,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_CONTEXT_SYSTEM_PROMPT,
    userPrompt: buildStoryContextUserPrompt(input),
  };
}

export function buildStoryContextRepairLlmRequest(
  input: Readonly<{
    errorMessage: string;
    input: GenerateStoryContextPatchInput;
    invalidResponse: string;
  }>,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_CONTEXT_REPAIR_SYSTEM_PROMPT,
    userPrompt: buildStoryContextRepairUserPrompt(input),
  };
}

export function parseStoryContextPatchResponse(
  value: string,
):
  | Readonly<{ success: true; patch: StoryContextPatchDraft }>
  | Readonly<{ success: false; message: string }> {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return { success: false, message: "Context response is empty" };
  }

  if (!normalizedValue.startsWith("{") || !normalizedValue.endsWith("}")) {
    return {
      success: false,
      message: "Context response must be pure JSON",
    };
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(normalizedValue) as unknown;
  } catch (error: unknown) {
    return { success: false, message: toErrorMessage(error) };
  }

  const result = StoryContextPatchDraftSchema.safeParse(parsedValue);
  if (result.success) {
    return { success: true, patch: result.data };
  }

  const repairedPatch = repairStoryContextPatchValue(parsedValue);
  if (repairedPatch.success) {
    return { success: true, patch: repairedPatch.patch };
  }

  const firstIssue = result.error.issues[0];
  return {
    success: false,
    message:
      firstIssue?.message ??
      repairedPatch.message ??
      "Context patch schema is invalid",
  };
}

function buildStoryContextUserPrompt(
  input: GenerateStoryContextPatchInput,
): string {
  const promptParts: string[] = [
    "请维护当前故事线的 StoryContextPatchDraft。",
    "",
    "输出 JSON schema 说明（minified JSON 示例；只输出 patch，不要输出完整 snapshot）：",
    getPatchSchemaDescription(),
    "",
    "可用来源 sourceRefs：",
  ];

  for (const source of input.sourceRefMappings) {
    promptParts.push(`- ${source.ref}：${source.label}`);
  }

  promptParts.push(
    "",
    "旧故事上下文（minified JSON）：",
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
    "- 只输出单行 JSON，不要换行，不要缩进。",
    "- 输出的是增量 patch，不是完整 StoryContextSnapshot。",
    "- 近期故事上下文和本轮正文共同构成本次待提取批次，不要遗漏较早片段中的关键变化。",
    "- 旧 context 中没有变化的 worldFacts 和 characters 不要输出。",
    "- 新事实放入 worldFacts.add；已有事实只有 text/status/visibility/sourceRefs 变化时才放入 worldFacts.update。",
    "- 新角色放入 characters.add；已有角色只有本轮新增认知、关系、观点、行动倾向或 currentStatus 变化时才放入 characters.update。",
    "- 每轮新增 worldFacts 最多 8 条，更新 worldFacts 最多 6 条。",
    "- 每轮新增 characters 最多 2 个，更新 characters 最多 4 个。",
    "- 每个角色本轮新增 beliefs 最多 8 条，opinions 最多 6 条，relationships 最多 6 条。",
    '- defaultSourceRefs 通常输出 ["current"]；单个 item 缺省 sourceRefs 时继承 defaultSourceRefs。',
    "- existingId 可以引用旧 context 中已有的 char_N / fact_N。",
    "- draftKey 用于本轮新增角色或事实，后续 refs 可以引用它。",
    '- relationshipsAdded 的每一项都必须是对象：{"targetCharacterRefs":["char_N 或 draftKey"],"text":"关系描述","sourceRefs":["可选"]}。',
    '- beliefsAdded 的每一项都必须是对象：{"text":"认知内容","truthStatus":"true | false | unknown","factRefs":["可选，fact_N 或 draftKey"],"sourceRefs":["可选"]}。',
    '- opinionsAdded 的每一项都必须是对象：{"target":"评价对象","text":"观点内容","sourceRefs":["可选"]}。',
    "- beliefsAdded 的 factRefs 只能引用事实 ref（fact_N 或事实 draftKey），绝不能引用 char_N 或角色 draftKey。",
    "- sourceRefs 只能使用上方列出的来源。",
    "- 不要创造输入中没有依据的新事实。",
    "- 不要主动制造错误记忆；只有正文明确表现角色误解时，才记录 truthStatus 为 false 的 belief。",
  );

  return promptParts.join("\n");
}

function buildStoryContextRepairUserPrompt(
  input: Readonly<{
    errorMessage: string;
    input: GenerateStoryContextPatchInput;
    invalidResponse: string;
  }>,
): string {
  return [
    "请修复以下 StoryContextPatchDraft JSON，使它通过 schema 校验。",
    "",
    "校验失败原因：",
    input.errorMessage,
    "",
    "输出 JSON schema 说明（minified JSON 示例）：",
    getPatchSchemaDescription(),
    "",
    "合法 sourceRefs：",
    ...input.input.sourceRefMappings.map((source) => `- ${source.ref}`),
    "",
    "修复规则：",
    "- 只输出单行 JSON，不要换行，不要缩进。",
    "- 不要输出完整 StoryContextSnapshot。",
    "- 保留原 patch 中不冲突的事实、角色、关系、认知和场景信息。",
    "- 不要新增输入中没有依据的新事实。",
    '- truthStatus 只能是 "true"、"false" 或 "unknown"；无法判断时使用 "unknown"。',
    "- relationshipsAdded 的每一项都必须包含 targetCharacterRefs:string[] 和 text:string。",
    "- beliefsAdded 和 opinionsAdded 的每一项都必须是对象，不能输出字符串数组。",
    "- beliefsAdded 的 factRefs 只能保留事实 ref，不能输出 char_N 或角色 draftKey。",
    "- sourceRefs 只能使用上方列出的合法 sourceRefs。",
    "- draftKey 与 refs 必须能互相对应。",
    "",
    "待修复的 JSON：",
    input.invalidResponse,
  ].join("\n");
}

function getPatchSchemaDescription(): string {
  return JSON.stringify({
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [
        {
          draftKey: "new_fact_key",
          kind: "event | setting | environment | relationship | status | term",
          text: "新增事实",
          status: "active | resolved",
          visibility: "observable | public | hidden",
          sourceRefs: ["可选，默认继承 defaultSourceRefs"],
        },
      ],
      update: [
        {
          existingId: "fact_N",
          text: "可选",
          status: "可选",
          visibility: "可选",
          sourceRefs: ["可选"],
        },
      ],
      resolve: ["fact_N"],
    },
    characters: {
      add: [
        {
          draftKey: "new_char_key",
          name: "角色名",
          aliases: [],
          identity: "",
          traits: [],
          relationshipsAdded: [
            {
              targetCharacterRefs: ["char_N 或 draftKey"],
              text: "关系描述",
              sourceRefs: ["可选"],
            },
          ],
          motivations: [],
          currentStatus: "",
          beliefsAdded: [
            {
              text: "角色认知",
              truthStatus: "true | false | unknown",
              factRefs: ["fact_N 或 draftKey"],
              sourceRefs: ["可选"],
            },
          ],
          opinionsAdded: [
            {
              target: "评价对象",
              text: "观点内容",
              sourceRefs: ["可选"],
            },
          ],
          actionTendenciesAdded: [],
          sourceRefs: ["可选"],
        },
      ],
      update: [
        {
          existingId: "char_N",
          aliasesAdded: [],
          traitsAdded: [],
          relationshipsAdded: [
            {
              targetCharacterRefs: ["char_N 或 draftKey"],
              text: "关系描述",
              sourceRefs: ["可选"],
            },
          ],
          motivationsAdded: [],
          currentStatus: "可选",
          beliefsAdded: [
            {
              text: "角色认知",
              truthStatus: "true | false | unknown",
              factRefs: ["fact_N 或 draftKey"],
              sourceRefs: ["可选"],
            },
          ],
          opinionsAdded: [
            {
              target: "评价对象",
              text: "观点内容",
              sourceRefs: ["可选"],
            },
          ],
          actionTendenciesAdded: [],
          sourceRefs: ["可选"],
        },
      ],
    },
    currentScene: {
      location: "可选，地点",
      timeLabel: "可选，时间或阶段",
      presentCharacterRefs: ["char_N 或 draftKey"],
      observableFactRefs: ["fact_N 或 draftKey"],
      sceneStatus: "可选，场景状态",
      sourceRefs: ["可选，默认继承 defaultSourceRefs"],
    },
  });
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
  round: GenerateStoryContextPatchInput["recentHistoryRounds"][number],
): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动输入：`
    : `第 ${round.roundIndex} 轮续写指令：`;
}

function formatRoundTextLabel(
  round: GenerateStoryContextPatchInput["recentHistoryRounds"][number],
): string {
  return round.generationMode === "dialogue"
    ? `第 ${round.roundIndex} 轮互动正文：`
    : `第 ${round.roundIndex} 轮续写正文：`;
}

function stringifyPromptJson(value: unknown): string {
  return JSON.stringify(value);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Story context generation was aborted");
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
