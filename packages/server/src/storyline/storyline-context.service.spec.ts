import type { GenerateLlmTextResponse } from "@kimiko/schema";
import type { LlmService } from "../llm/llm.service";
import { StorylineContextService } from "./storyline-context.service";
import type {
  GenerateStoryContextPatchInput,
  StoryContextPatchDraft,
} from "./storyline-context-patch.types";

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

  it("repairs deterministic context patch issues locally", async () => {
    const invalidPatch = {
      ...createContextPatch(),
      characters: {
        add: [
          {
            ...createContextPatch().characters.add[0],
            beliefsAdded: [
              {
                text: "林夏知道门已经打开。",
                truthStatus: "正确",
                factRefs: ["opened_door"],
              },
            ],
          },
        ],
        update: [],
      },
    };
    llmService.generateTextFromParsedRequest.mockResolvedValueOnce(
      createLlmResponse(invalidPatch),
    );

    const patch = await contextService.generateStoryContextPatch(
      createContextInput(),
      {
        signal: new AbortController().signal,
      },
    );

    expect(llmService.generateTextFromParsedRequest).toHaveBeenCalledTimes(1);
    expect(patch.characters.add[0]?.beliefsAdded?.[0]?.truthStatus).toBe(
      "unknown",
    );
  });

  it("uses one LLM repair when the context patch is not pure JSON", async () => {
    const repairedPatch = createContextPatch();
    llmService.generateTextFromParsedRequest
      .mockResolvedValueOnce({
        text: `修复后的 JSON：${JSON.stringify(createContextPatch())}`,
        model: "context-model",
      })
      .mockResolvedValueOnce(createLlmResponse(repairedPatch));

    await expect(
      contextService.generateStoryContextPatch(createContextInput(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(repairedPatch);

    expect(llmService.generateTextFromParsedRequest).toHaveBeenCalledTimes(2);
    const repairCall = llmService.generateTextFromParsedRequest.mock.calls[1];
    if (repairCall === undefined) {
      throw new Error("Expected repair call");
    }

    expect(repairCall[0].userPrompt).toContain(
      "Context response must be pure JSON",
    );
    expect(repairCall[0].userPrompt).toContain("待修复的 JSON");
    expect(repairCall[0].userPrompt).toContain(
      "不要输出完整 StoryContextSnapshot",
    );
  });

  it("builds minified JSON prompt sections", async () => {
    llmService.generateTextFromParsedRequest.mockResolvedValueOnce(
      createLlmResponse(createContextPatch()),
    );

    await contextService.generateStoryContextPatch(createContextInput(), {
      signal: new AbortController().signal,
    });

    const call = llmService.generateTextFromParsedRequest.mock.calls[0];
    if (call === undefined) {
      throw new Error("Expected context call");
    }

    expect(call[0].userPrompt).toContain("旧故事上下文（minified JSON）：");
    expect(call[0].userPrompt).toContain(
      '"currentScene":{"location":"","timeLabel":"","presentCharacterIds":[]',
    );
    expect(call[0].userPrompt).not.toContain('\n  "worldFacts"');
  });
});

function createContextInput(): GenerateStoryContextPatchInput {
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

function createContextPatch(): StoryContextPatchDraft {
  return {
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [
        {
          draftKey: "opened_door",
          kind: "event",
          text: "林夏推开门。",
          status: "active",
          visibility: "observable",
        },
      ],
      update: [],
      resolve: [],
    },
    characters: {
      add: [
        {
          draftKey: "lin_xia",
          name: "林夏",
          currentStatus: "站在门口。",
          beliefsAdded: [
            {
              text: "林夏知道门已经打开。",
              truthStatus: "true",
              factRefs: ["opened_door"],
            },
          ],
        },
      ],
      update: [],
    },
    currentScene: {
      location: "门口",
      timeLabel: "当前",
      presentCharacterRefs: ["lin_xia"],
      observableFactRefs: ["opened_door"],
      sceneStatus: "门已经打开。",
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
