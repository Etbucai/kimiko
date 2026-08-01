import { InternalServerErrorException } from "@nestjs/common";
import { StorylineTitleSchema } from "@kimiko/schema";
import type { StorylineTitle } from "@kimiko/schema";

const storylineTitleMaxLength = 80;
const openingMarker = "【开场】";

export function deriveStorylineTitle(initialText: string): StorylineTitle {
  const titleSource = getStorylineTitleSourceText(initialText);
  const title = truncateTitle(getFirstNonEmptyLine(titleSource));
  const result = StorylineTitleSchema.safeParse(title);
  if (!result.success) {
    throw new InternalServerErrorException("Storyline title is invalid");
  }

  return result.data;
}

export function resolveStorylineTitle(input: {
  readonly explicitTitle: string | null;
  readonly initialText: string;
}): StorylineTitle {
  if (input.explicitTitle === null) {
    return deriveStorylineTitle(input.initialText);
  }

  const result = StorylineTitleSchema.safeParse(input.explicitTitle);
  if (!result.success) {
    throw new InternalServerErrorException("Storyline title is invalid");
  }

  return result.data;
}

function getFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map(normalizeTitle)
    .find((line) => line.length > 0);

  return firstLine ?? normalizeTitle(value);
}

function getStorylineTitleSourceText(initialText: string): string {
  const openingMarkerIndex = initialText.indexOf(openingMarker);
  if (openingMarkerIndex < 0) {
    return initialText;
  }

  const openingText = initialText.slice(
    openingMarkerIndex + openingMarker.length,
  );
  return openingText.trim().length > 0 ? openingText : initialText;
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateTitle(value: string): string {
  if (value.length <= storylineTitleMaxLength) {
    return value;
  }

  return `${value.slice(0, storylineTitleMaxLength - 3).trimEnd()}...`;
}
