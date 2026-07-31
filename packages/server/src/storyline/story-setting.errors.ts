export class StorySettingNotFoundError extends Error {
  constructor(message = "Story setting was not found") {
    super(message);
    this.name = "StorySettingNotFoundError";
  }
}

export class StorySettingSaveFailedError extends Error {
  constructor(message = "Failed to save story setting") {
    super(message);
    this.name = "StorySettingSaveFailedError";
  }
}
