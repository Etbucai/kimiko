import type { CompletedStorylineSnapshot } from "@kimiko/schema";
import type { StoryService, StoryStreamEvent } from "../story/story.service";
import type { StorylineLockService } from "./storyline-lock.service";
import type { StorylineService } from "./storyline.service";
import type { StorylineSummaryService } from "./storyline-summary.service";
import { StorylineGenerationService } from "./storyline-generation.service";

describe("StorylineGenerationService", () => {
  let storylineService: jest.Mocked<Pick<
    StorylineService,
    | "getStorylineForUser"
    | "buildRewriteLlmContext"
    | "saveRewrittenSegmentWithSummary"
  >>;
  let storyService: jest.Mocked<Pick<StoryService, "streamRewriteStoryFromContext">>;
  let lockService: jest.Mocked<Pick<StorylineLockService, "acquireStorylineLock">>;
  let summaryService: jest.Mocked<Pick<StorylineSummaryService, "generateCharacterSummary">>;
  let releaseLock: jest.Mock;
  let generationService: StorylineGenerationService;

  beforeEach(() => {
    storylineService = {
      getStorylineForUser: jest.fn(),
      buildRewriteLlmContext: jest.fn(),
      saveRewrittenSegmentWithSummary: jest.fn(),
    };
    storyService = {
      streamRewriteStoryFromContext: jest.fn(),
    };
    releaseLock = jest.fn();
    lockService = {
      acquireStorylineLock: jest.fn((_storylineId: string) => releaseLock),
    };
    summaryService = {
      generateCharacterSummary: jest.fn(),
    };
    generationService = new StorylineGenerationService(
      storylineService as unknown as StorylineService,
      storyService as unknown as StoryService,
      lockService as unknown as StorylineLockService,
      summaryService as unknown as StorylineSummaryService,
    );
  });

  it("streams rewrite chunks, summarizes with previous summary and saves in place", async () => {
    const abortController = new AbortController();
    const previousSummary = {
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在前往钟楼",
        },
      ],
    };
    const writerContext = {
      rewriteInstruction: "文风更加轻快。",
      originalInstruction: "进入钟楼。",
      originalGeneratedText: "林夏推开钟楼木门。",
      initialStoryText: "雨停以后。",
      historyRoundsBeforeTarget: [
        {
          roundIndex: 1,
          instruction: "前往钟楼。",
          generatedText: "林夏走向钟楼。",
        },
      ],
      historyWasTrimmed: false,
    };
    const rewrittenSummary = {
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在钟楼门口观察",
        },
      ],
    };
    const completedStoryline: CompletedStorylineSnapshot = {
      id: "10",
      segments: [
        { id: "1", type: "initial", text: "雨停以后。" },
        { id: "2", type: "generated", text: "林夏走向钟楼。" },
        { id: "3", type: "generated", text: "林夏轻快地推开钟楼木门。" },
      ],
      latestGeneration: {
        segmentId: "3",
        model: "rewrite-model",
        elapsedMs: 42,
        usage: {
          inputTokens: 7,
          outputTokens: 8,
          totalTokens: 15,
        },
      },
      updatedAt: "2026-07-22T00:00:00.000Z",
    };

    storylineService.getStorylineForUser.mockResolvedValue({
      id: 10,
      externalId: "10",
      userId: 1,
    });
    storylineService.buildRewriteLlmContext.mockResolvedValue({
      storyline: {
        id: 10,
        externalId: "10",
        userId: 1,
      },
      targetSegmentId: "3",
      previousSummary,
      writerContext,
      summaryHistoryRounds: writerContext.historyRoundsBeforeTarget,
      initialStoryText: writerContext.initialStoryText,
    });
    storyService.streamRewriteStoryFromContext.mockReturnValue(
      createStoryStream([
        {
          type: "chunk",
          delta: "林夏",
          sequence: 1,
        },
        {
          type: "completed",
          continuedStory: "林夏轻快地推开钟楼木门。",
          model: "rewrite-model",
          elapsedMs: 42,
          usage: {
            inputTokens: 7,
            outputTokens: 8,
            totalTokens: 15,
          },
        },
      ]),
    );
    summaryService.generateCharacterSummary.mockResolvedValue(rewrittenSummary);
    storylineService.saveRewrittenSegmentWithSummary.mockResolvedValue(
      completedStoryline,
    );

    const events = await collectAsyncIterable(
      generationService.streamContinueStoryline(
        {
          userId: "1",
          payload: {
            mode: "rewrite",
            storylineId: "10",
            segmentId: "3",
            instruction: "文风更加轻快。",
          },
        },
        { signal: abortController.signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "林夏",
        sequence: 1,
      },
      { type: "summaryStarted" },
      {
        type: "completed",
        storyline: completedStoryline,
        generatedSegmentId: "3",
      },
    ]);
    expect(lockService.acquireStorylineLock).toHaveBeenCalledWith("10");
    expect(storyService.streamRewriteStoryFromContext).toHaveBeenCalledWith(
      writerContext,
      { signal: abortController.signal },
    );
    expect(summaryService.generateCharacterSummary).toHaveBeenCalledWith(
      {
        operation: "rewrite",
        previousSummary,
        initialStoryText: "雨停以后。",
        recentHistoryRounds: writerContext.historyRoundsBeforeTarget,
        currentInstruction: "文风更加轻快。",
        generatedText: "林夏轻快地推开钟楼木门。",
      },
      { signal: abortController.signal },
    );
    expect(
      storylineService.saveRewrittenSegmentWithSummary,
    ).toHaveBeenCalledWith({
      userId: "1",
      storylineId: "10",
      segmentId: "3",
      instruction: "文风更加轻快。",
      generatedText: "林夏轻快地推开钟楼木门。",
      model: "rewrite-model",
      elapsedMs: 42,
      usage: {
        inputTokens: 7,
        outputTokens: 8,
        totalTokens: 15,
      },
      characterSummary: rewrittenSummary,
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

async function collectAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }

  return events;
}

async function* createStoryStream(
  events: readonly StoryStreamEvent[],
): AsyncIterable<StoryStreamEvent> {
  for (const event of events) {
    yield event;
  }
}
