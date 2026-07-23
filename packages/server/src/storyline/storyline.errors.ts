export class StorylineBusyError extends Error {
  constructor(message = "Storyline is busy") {
    super(message);
    this.name = "StorylineBusyError";
  }
}

export class StorylineNotFoundError extends Error {
  constructor(message = "Storyline was not found") {
    super(message);
    this.name = "StorylineNotFoundError";
  }
}

export class StorylineSaveFailedError extends Error {
  constructor(message = "Failed to save storyline") {
    super(message);
    this.name = "StorylineSaveFailedError";
  }
}

export class StorySegmentNotRewritableError extends Error {
  constructor(message = "Story segment is not rewritable") {
    super(message);
    this.name = "StorySegmentNotRewritableError";
  }
}

export class StorySummaryFailedError extends Error {
  constructor(message = "Failed to generate story summary") {
    super(message);
    this.name = "StorySummaryFailedError";
  }
}
