import { StorylineBusyError } from "./storyline.errors";
import { StorylineLockService } from "./storyline-lock.service";

describe("StorylineLockService", () => {
  let lockService: StorylineLockService;

  beforeEach(() => {
    lockService = new StorylineLockService();
  });

  it("prevents concurrent create generations for the same user", () => {
    const release = lockService.acquireCreateLock("user-1");

    expect(() => lockService.acquireCreateLock("user-1")).toThrow(
      StorylineBusyError,
    );
    expect(() => lockService.acquireCreateLock("user-2")).not.toThrow();

    release();
    expect(() => lockService.acquireCreateLock("user-1")).not.toThrow();
  });

  it("prevents concurrent append generations for the same storyline", () => {
    const release = lockService.acquireStorylineLock("storyline-1");

    expect(() => lockService.acquireStorylineLock("storyline-1")).toThrow(
      StorylineBusyError,
    );
    expect(() =>
      lockService.acquireStorylineLock("storyline-2"),
    ).not.toThrow();

    release();
    release();
    expect(() =>
      lockService.acquireStorylineLock("storyline-1"),
    ).not.toThrow();
  });
});
