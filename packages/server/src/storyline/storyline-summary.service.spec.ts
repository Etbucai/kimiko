import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import type { LlmProvider, LlmTextStreamEvent } from "../llm/llm.provider";
import { LlmService } from "../llm/llm.service";
import { StorySummaryFailedError } from "./storyline.errors";
import {
  buildCharacterSummaryLlmRequest,
  parseCharacterSummaryResponse,
  STORY_SUMMARY_SYSTEM_PROMPT,
  StorylineSummaryService,
} from "./storyline-summary.service";

describe("StorylineSummaryService", () => {
  let llmProvider: jest.Mocked<LlmProvider>;
  let summaryService: StorylineSummaryService;

  beforeEach(() => {
    llmProvider = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
      >(),
      streamText: jest.fn<
        AsyncIterable<LlmTextStreamEvent>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
      >(),
    };
    summaryService = new StorylineSummaryService(new LlmService(llmProvider));
  });

  it("builds the extractor prompt from prior summary and current story data", () => {
    const request = buildCharacterSummaryLlmRequest({
      operation: "append",
      previousSummary: {
        characters: [
          {
            name: "林夏",
            aliases: ["林记者"],
            identity: "调查旧钟楼的记者",
            relationships: ["与周岚是旧识"],
            motivation: "查清钟楼失踪案",
            currentStatus: "正在旧书店寻找线索",
          },
        ],
      },
      initialStoryText: "雨停以后。",
      recentHistoryRounds: [
        {
          roundIndex: 1,
          generationMode: "append",
          instruction: "调查旧书店。",
          generatedText: "林夏回到旧书店。",
        },
      ],
      currentInstruction: "前往钟楼。",
      generatedText: "林夏走向钟楼。",
    });

    expect(request.systemPrompt).toBe(STORY_SUMMARY_SYSTEM_PROMPT);
    expect(request.userPrompt).toContain("旧角色摘要：");
    expect(request.userPrompt).toContain('"name": "林夏"');
    expect(request.userPrompt).toContain("初始故事正文：");
    expect(request.userPrompt).toContain("近期故事上下文：");
    expect(request.userPrompt).toContain("本轮续写指令：");
    expect(request.userPrompt).toContain("本轮生成正文：");
  });

  it("labels rewrite instructions distinctly in the extractor prompt", () => {
    const request = buildCharacterSummaryLlmRequest({
      operation: "rewrite",
      previousSummary: null,
      recentHistoryRounds: [],
      currentInstruction: "文风更加轻快。",
      generatedText: "林夏重新走向钟楼。",
    });

    expect(request.userPrompt).toContain("本轮重写指令：");
    expect(request.userPrompt).not.toContain("本轮续写指令：");
  });

  it("labels dialogue inputs and text distinctly in the extractor prompt", () => {
    const request = buildCharacterSummaryLlmRequest({
      operation: "dialogue",
      previousSummary: null,
      recentHistoryRounds: [
        {
          roundIndex: 1,
          generationMode: "dialogue",
          instruction: "大凡让馥冰拿奶茶。",
          generatedText: "馥冰白了他一眼。",
        },
      ],
      currentInstruction: "大凡让馥冰拿奶茶。",
      generatedText: '馥冰没好气地说，"你自己没长手啊。"',
    });

    expect(request.userPrompt).toContain("第 1 轮互动输入：");
    expect(request.userPrompt).toContain("第 1 轮互动正文：");
    expect(request.userPrompt).toContain("本轮互动输入：");
    expect(request.userPrompt).toContain("本轮互动正文：");
  });

  it("parses valid character summary JSON and allows an empty list", () => {
    expect(parseCharacterSummaryResponse('{ "characters": [] }')).toEqual({
      characters: [],
    });

    expect(
      parseCharacterSummaryResponse(
        JSON.stringify({
          characters: [
            {
              name: "林夏",
              aliases: [],
              identity: "调查旧钟楼的记者",
              relationships: ["与周岚是旧识"],
              motivation: "查清钟楼失踪案",
              currentStatus: "正在前往钟楼",
            },
          ],
        }),
      ),
    ).toEqual({
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "调查旧钟楼的记者",
          relationships: ["与周岚是旧识"],
          motivation: "查清钟楼失踪案",
          currentStatus: "正在前往钟楼",
        },
      ],
    });
  });

  it("rejects non-json, markdown wrappers and invalid schemas", () => {
    expect(() => parseCharacterSummaryResponse("not json")).toThrow(
      StorySummaryFailedError,
    );
    expect(() =>
      parseCharacterSummaryResponse('```json\n{"characters":[]}\n```'),
    ).toThrow(StorySummaryFailedError);
    expect(() =>
      parseCharacterSummaryResponse(
        JSON.stringify({
          characters: [
            {
              name: "林夏",
              aliases: [],
              identity: "a".repeat(241),
              relationships: [],
              motivation: "",
              currentStatus: "",
            },
          ],
        }),
      ),
    ).toThrow(StorySummaryFailedError);
  });

  it("generates summaries through the LLM service and forwards abort signals", async () => {
    const abortController = new AbortController();
    llmProvider.generateText.mockResolvedValue({
      text: JSON.stringify({
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "调查旧钟楼的记者",
            relationships: [],
            motivation: "查清钟楼失踪案",
            currentStatus: "正在前往钟楼",
          },
        ],
      }),
      model: "summary-model",
    });

    await expect(
      summaryService.generateCharacterSummary(
        {
          operation: "append",
          previousSummary: null,
          initialStoryText: "雨停以后。",
          recentHistoryRounds: [],
          currentInstruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
        { signal: abortController.signal },
      ),
    ).resolves.toMatchObject({
      characters: [
        {
          name: "林夏",
        },
      ],
    });

    expect(llmProvider.generateText.mock.calls[0]?.[1]).toEqual({
      signal: abortController.signal,
    });
  });

  it("maps invalid LLM responses to summary failures", async () => {
    llmProvider.generateText.mockResolvedValue({
      text: "not json",
      model: "summary-model",
    });

    await expect(
      summaryService.generateCharacterSummary(
        {
          operation: "append",
          previousSummary: null,
          recentHistoryRounds: [],
          currentInstruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(StorySummaryFailedError);
  });
});
