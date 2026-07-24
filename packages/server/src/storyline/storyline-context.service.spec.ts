import type { GenerateLlmTextResponse } from "@kimiko/schema";
import type { LlmService } from "../llm/llm.service";
import { StorylineContextService } from "./storyline-context.service";
import type {
  GenerateStoryContextInput,
  StoryContextDraftSnapshot,
} from "./storyline-context.types";

describe("StorylineContextService", () => {
  let llmService: jest.Mocked<
    Pick<LlmService, "generateTextFromParsedRequest">
  >;
  let contextService: StorylineContextService;

  beforeEach(() => {
    llmService = {
      generateTextFromParsedRequest: jest.fn(),
    };
    contextService = new StorylineContextService(
      llmService as unknown as LlmService,
    );
  });

  it("repairs an invalid context draft once before returning it", async () => {
    const invalidDraft = {
      ...createContextDraft(),
      characters: [
        {
          ...createContextDraft().characters[0],
          beliefs: [
            {
              text: "林夏知道门已经打开。",
              truthStatus: "正确",
              factRefs: ["opened_door"],
              sourceRefs: ["current"],
            },
          ],
        },
      ],
    };
    const repairedDraft = createContextDraft();

    llmService.generateTextFromParsedRequest
      .mockResolvedValueOnce(createLlmResponse(invalidDraft))
      .mockResolvedValueOnce(createLlmResponse(repairedDraft));

    await expect(
      contextService.generateStoryContextDraft(createContextInput(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(repairedDraft);

    expect(llmService.generateTextFromParsedRequest).toHaveBeenCalledTimes(2);
    const repairCall = llmService.generateTextFromParsedRequest.mock.calls[1];
    if (repairCall === undefined) {
      throw new Error("Expected repair call");
    }

    expect(repairCall[0].userPrompt).toContain("Invalid option");
    expect(repairCall[0].userPrompt).toContain("待修复的 JSON");
    expect(repairCall[0].userPrompt).toContain('"truthStatus":"正确"');
  });
});

function createContextInput(): GenerateStoryContextInput {
  return {
    operation: "append",
    previousContext: null,
    sourceRefMappings: [
      {
        ref: "current",
        label: "本轮生成正文",
        text: "林夏推开门。",
      },
    ],
    recentHistoryRounds: [],
    currentInstruction: "继续写林夏推开门。",
    generatedText: "林夏推开门，看见走廊尽头亮着灯。",
  };
}

function createContextDraft(): StoryContextDraftSnapshot {
  return {
    worldFacts: [
      {
        draftKey: "opened_door",
        kind: "event",
        text: "林夏推开门。",
        status: "active",
        visibility: "observable",
        sourceRefs: ["current"],
      },
    ],
    characters: [
      {
        draftKey: "lin_xia",
        name: "林夏",
        aliases: [],
        identity: "",
        traits: [],
        relationships: [],
        motivations: [],
        currentStatus: "站在门口。",
        beliefs: [
          {
            text: "林夏知道门已经打开。",
            truthStatus: "true",
            factRefs: ["opened_door"],
            sourceRefs: ["current"],
          },
        ],
        opinions: [],
        actionTendencies: [],
        sourceRefs: ["current"],
      },
    ],
    currentScene: {
      location: "门口",
      timeLabel: "当前",
      presentCharacterRefs: ["lin_xia"],
      observableFactRefs: ["opened_door"],
      sceneStatus: "门已经打开。",
      sourceRefs: ["current"],
    },
  };
}

function createLlmResponse(value: unknown): GenerateLlmTextResponse {
  return {
    text: JSON.stringify(value),
    model: "context-model",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  };
}
