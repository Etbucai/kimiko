import type { StorylineContextExtractionService } from "./storyline-context-extraction.service";
import { StoryContextExtractionTaskService } from "./story-context-extraction-task.service";
import type { StorylineLockService } from "./storyline-lock.service";

describe("StoryContextExtractionTaskService", () => {
  let extractionService: jest.Mocked<
    Pick<StorylineContextExtractionService, "extractNextBatch" | "getState">
  >;
  let lockService: jest.Mocked<
    Pick<StorylineLockService, "acquireStorylineLock">
  >;
  let releaseLock: jest.Mock;
  let taskService: StoryContextExtractionTaskService;

  beforeEach(() => {
    extractionService = {
      extractNextBatch: jest.fn(),
      getState: jest.fn(),
    };
    releaseLock = jest.fn();
    lockService = {
      acquireStorylineLock: jest.fn((_storylineId: string) => releaseLock),
    };
    taskService = new StoryContextExtractionTaskService(
      extractionService as unknown as StorylineContextExtractionService,
      lockService as unknown as StorylineLockService,
    );
  });

  it("processes every pending batch and reports progress", async () => {
    extractionService.getState.mockResolvedValue({
      context: null,
      extractedThroughOrderIndex: 0,
      pendingRoundCount: 15,
    });
    extractionService.extractNextBatch
      .mockResolvedValueOnce({
        extractedRoundCount: 10,
        pendingRoundCount: 5,
      })
      .mockResolvedValueOnce({
        extractedRoundCount: 5,
        pendingRoundCount: 0,
      });

    await taskService.start({ userId: "1", storylineId: "10" });
    await flushPromises();

    expect(taskService.getStatus({ userId: "1", storylineId: "10" })).toEqual({
      task: {
        status: "completed",
        processedRoundCount: 15,
        totalRoundCount: 15,
        pendingRoundCount: 0,
        message: null,
      },
    });
    expect(extractionService.extractNextBatch).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps completed batch progress when a later batch fails", async () => {
    extractionService.getState.mockResolvedValue({
      context: null,
      extractedThroughOrderIndex: 0,
      pendingRoundCount: 15,
    });
    extractionService.extractNextBatch
      .mockResolvedValueOnce({
        extractedRoundCount: 10,
        pendingRoundCount: 5,
      })
      .mockRejectedValueOnce(new Error("provider failed"));

    await taskService.start({ userId: "1", storylineId: "10" });
    await flushPromises();

    expect(taskService.getStatus({ userId: "1", storylineId: "10" })).toEqual({
      task: {
        status: "failed",
        processedRoundCount: 10,
        totalRoundCount: 15,
        pendingRoundCount: 5,
        message: "provider failed",
      },
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
