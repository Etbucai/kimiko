import { Injectable } from "@nestjs/common";
import { StorylineBusyError } from "./storyline.errors";

type StorylineLockKey = `create:${string}` | `storyline:${string}`;

@Injectable()
export class StorylineLockService {
  private readonly activeLocks = new Set<StorylineLockKey>();

  acquireCreateLock(userId: string): () => void {
    return this.acquireLock(`create:${userId}`);
  }

  acquireStorylineLock(storylineId: string): () => void {
    return this.acquireLock(`storyline:${storylineId}`);
  }

  private acquireLock(lockKey: StorylineLockKey): () => void {
    if (this.activeLocks.has(lockKey)) {
      throw new StorylineBusyError();
    }

    let released = false;
    this.activeLocks.add(lockKey);

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.activeLocks.delete(lockKey);
    };
  }
}
