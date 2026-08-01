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

export class StorylineCopyChapterOutOfRangeError extends Error {
  constructor(message = "Storyline copy chapter is out of range") {
    super(message);
    this.name = "StorylineCopyChapterOutOfRangeError";
  }
}

export class StorylineCopyFailedError extends Error {
  constructor(message = "Failed to copy storyline") {
    super(message);
    this.name = "StorylineCopyFailedError";
  }
}

export class StorySegmentNotRewritableError extends Error {
  constructor(message = "Story segment is not rewritable") {
    super(message);
    this.name = "StorySegmentNotRewritableError";
  }
}

export class StoryContextFailedError extends Error {
  constructor(message = "Failed to generate story context") {
    super(message);
    this.name = "StoryContextFailedError";
  }
}
