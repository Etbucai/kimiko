import { Injectable } from "@nestjs/common";
import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { LlmService } from "../llm/llm.service";
import { StorySummaryFailedError } from "./storyline.errors";
import {
  StoryCharacterSummarySnapshotSchema,
  type GenerateCharacterSummaryInput,
  type StoryCharacterSummarySnapshot,
} from "./storyline-summary.types";

export const STORY_SUMMARY_SYSTEM_PROMPT = [
  "你是 StoryAgent 的角色摘要维护器。",
  "你只负责维护重要角色摘要，不负责续写正文。",
  "你必须只输出 JSON，不输出解释、Markdown 或额外文本。",
  "你只能根据输入中的旧角色摘要、历史片段、当前指令和本轮正文更新摘要。",
  "不要创造输入中没有依据的新角色事实。",
  "只记录重要角色，忽略路人和一次性背景人物。",
  "输出必须符合指定 JSON schema。",
].join("\n");

@Injectable()
export class StorylineSummaryService {
  constructor(private readonly llmService: LlmService) {}

  async generateCharacterSummary(
    input: GenerateCharacterSummaryInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<StoryCharacterSummarySnapshot> {
    try {
      assertNotAborted(options.signal);
      const response = await this.llmService.generateTextFromParsedRequest(
        buildCharacterSummaryLlmRequest(input),
        options,
      );
      assertNotAborted(options.signal);
      return parseCharacterSummaryResponse(response.text);
    } catch (error: unknown) {
      if (options.signal.aborted) {
        throw error;
      }

      if (error instanceof StorySummaryFailedError) {
        throw error;
      }

      throw new StorySummaryFailedError(toErrorMessage(error));
    }
  }
}

export function buildCharacterSummaryLlmRequest(
  input: GenerateCharacterSummaryInput,
): GenerateLlmTextRequest {
  return {
    systemPrompt: STORY_SUMMARY_SYSTEM_PROMPT,
    userPrompt: buildCharacterSummaryUserPrompt(input),
  };
}

export function parseCharacterSummaryResponse(
  value: string,
): StoryCharacterSummarySnapshot {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new StorySummaryFailedError("Summary response is empty");
  }

  if (!normalizedValue.startsWith("{") || !normalizedValue.endsWith("}")) {
    throw new StorySummaryFailedError("Summary response must be pure JSON");
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(normalizedValue) as unknown;
  } catch (error: unknown) {
    throw new StorySummaryFailedError(toErrorMessage(error));
  }

  const result = StoryCharacterSummarySnapshotSchema.safeParse(parsedValue);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const message =
      firstIssue === undefined
        ? "Summary schema is invalid"
        : firstIssue.message;
    throw new StorySummaryFailedError(message);
  }

  return result.data;
}

function buildCharacterSummaryUserPrompt(
  input: GenerateCharacterSummaryInput,
): string {
  const promptParts: string[] = [
    "请维护当前故事线的重要角色摘要。",
    "",
    "输出 JSON schema：",
    [
      "{",
      '  "characters": [',
      "    {",
      '      "name": "角色名或主要称呼",',
      '      "aliases": ["别名、称号或昵称"],',
      '      "identity": "身份、阵营或稳定定位",',
      '      "relationships": ["与其他重要角色的关键关系"],',
      '      "motivation": "稳定动机，没有明确动机时输出空字符串",',
      '      "currentStatus": "当前处境或状态，没有明确状态时输出空字符串"',
      "    }",
      "  ]",
      "}",
    ].join("\n"),
    "",
    "旧角色摘要：",
    stringifyPromptJson(input.previousSummary ?? { characters: [] }),
    "",
  ];

  const initialStoryText = input.initialStoryText?.trim();
  if (initialStoryText !== undefined && initialStoryText.length > 0) {
    promptParts.push("初始故事正文：", initialStoryText, "");
  }

  if (input.recentHistoryRounds.length > 0) {
    promptParts.push("近期故事上下文：");
    for (const round of input.recentHistoryRounds) {
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

  promptParts.push(
    getInstructionLabel(input.operation),
    input.currentInstruction,
    "",
    "本轮生成正文：",
    input.generatedText,
    "",
    "请输出新的完整角色摘要快照。只输出 JSON。",
  );

  return promptParts.join("\n");
}

function getInstructionLabel(
  operation: GenerateCharacterSummaryInput["operation"],
): string {
  return operation === "rewrite" ? "本轮重写指令：" : "本轮续写指令：";
}

function stringifyPromptJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Story summary generation was aborted");
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
