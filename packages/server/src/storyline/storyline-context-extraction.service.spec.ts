import type { StorylineContextService } from "./storyline-context.service";
import { StorylineContextExtractionService } from "./storyline-context-extraction.service";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";
import { emptyStoryContextSnapshot } from "./storyline-context.types";
import type { StorylineService } from "./storyline.service";

describe("StorylineContextExtractionService", () => {
  it("extracts one bounded batch and advances it atomically", async () => {
    const contextPatch = createEmptyContextPatch();
    const batch = {
      expectedExtractedThroughOrderIndex: 0,
      initialSegmentId: "1",
      initialStoryText: "故事开始。",
      previousContext: null,
      rounds: [
        {
          segmentId: "2",
          orderIndex: 1,
          roundIndex: 1,
          generationMode: "append" as const,
          instruction: "第一轮",
          generatedText: "第一轮正文",
        },
        {
          segmentId: "3",
          orderIndex: 2,
          roundIndex: 2,
          generationMode: "dialogue" as const,
          instruction: "第二轮",
          generatedText: "第二轮正文",
        },
      ] as const,
    };
    const storylineService = {
      getStoryContextExtractionBatch: jest.fn().mockResolvedValue(batch),
      applyStoryContextExtractionBatch: jest.fn().mockResolvedValue(undefined),
      getStoryContextExtractionState: jest.fn().mockResolvedValue({
        context: emptyStoryContextSnapshot,
        extractedThroughOrderIndex: 2,
        pendingRoundCount: 0,
      }),
    };
    const contextService = {
      generateStoryContextPatch: jest.fn().mockResolvedValue(contextPatch),
    };
    const service = new StorylineContextExtractionService(
      storylineService as unknown as StorylineService,
      contextService as unknown as StorylineContextService,
    );
    const signal = new AbortController().signal;

    await expect(
      service.extractNextBatch({
        userId: "1",
        storylineId: "10",
        signal,
      }),
    ).resolves.toEqual({
      extractedRoundCount: 2,
      pendingRoundCount: 0,
    });
    expect(contextService.generateStoryContextPatch).toHaveBeenCalledWith(
      {
        operation: "dialogue",
        previousContext: null,
        initialStoryText: "故事开始。",
        recentHistoryRounds: [batch.rounds[0]],
        currentInstruction: "第二轮",
        generatedText: "第二轮正文",
        sourceRefMappings: [
          {
            ref: "initial",
            label: "初始故事正文",
            text: "故事开始。",
          },
          {
            ref: "segment:2",
            label: "第 1 轮续写正文",
            text: "第一轮正文",
          },
          {
            ref: "current",
            label: "本批最后一轮互动正文",
            text: "第二轮正文",
          },
        ],
      },
      { signal },
    );
    expect(
      storylineService.applyStoryContextExtractionBatch,
    ).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      batch,
      contextPatch,
    });
  });
});

function createEmptyContextPatch(): StoryContextPatchDraft {
  return {
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [],
      update: [],
      resolve: [],
    },
    characters: {
      add: [],
      update: [],
    },
    currentScene: {},
  };
}
