import { STORYLINE_CHAPTER_CACHE_RADIUS } from "@kimiko/schema";
import type { StorylineChapter, StorylineSnapshot } from "@kimiko/schema";

export { STORYLINE_CHAPTER_CACHE_RADIUS };

export function findStorylineChapter(
  storyline: StorylineSnapshot,
  pageNumber: number,
): StorylineChapter | undefined {
  return storyline.chapters.find(
    (chapter) => chapter.pageNumber === pageNumber,
  );
}

export function mergeStorylineWindow(
  current: StorylineSnapshot | null,
  incoming: StorylineSnapshot,
  currentPageNumber: number,
): StorylineSnapshot {
  if (current?.id !== incoming.id) {
    return trimStorylineWindow(incoming, currentPageNumber);
  }

  if (incoming.updatedAt < current.updatedAt) {
    return trimStorylineWindow(current, currentPageNumber);
  }

  const retainedChapters =
    incoming.updatedAt > current.updatedAt
      ? current.chapters.filter(
          (chapter) => chapter.pageNumber !== current.chapterCount,
        )
      : current.chapters;
  const chaptersByPage = new Map(
    retainedChapters.map((chapter) => [chapter.pageNumber, chapter]),
  );

  for (const chapter of incoming.chapters) {
    chaptersByPage.set(chapter.pageNumber, chapter);
  }

  return trimStorylineWindow(
    {
      ...incoming,
      chapters: [...chaptersByPage.values()],
    },
    currentPageNumber,
  );
}

export function trimStorylineWindow(
  storyline: StorylineSnapshot,
  currentPageNumber: number,
): StorylineSnapshot {
  const anchorPage = clampPage(currentPageNumber, storyline.chapterCount);
  const startPage = Math.max(1, anchorPage - STORYLINE_CHAPTER_CACHE_RADIUS);
  const endPage = Math.min(
    storyline.chapterCount,
    anchorPage + STORYLINE_CHAPTER_CACHE_RADIUS,
  );

  return {
    ...storyline,
    anchorPage,
    chapters: storyline.chapters
      .filter(
        (chapter) =>
          chapter.pageNumber >= startPage && chapter.pageNumber <= endPage,
      )
      .sort((left, right) => left.pageNumber - right.pageNumber),
  };
}

export function getMissingChapterPages(
  storyline: StorylineSnapshot,
  currentPageNumber: number,
): number[] {
  const anchorPage = clampPage(currentPageNumber, storyline.chapterCount);
  const startPage = Math.max(1, anchorPage - STORYLINE_CHAPTER_CACHE_RADIUS);
  const endPage = Math.min(
    storyline.chapterCount,
    anchorPage + STORYLINE_CHAPTER_CACHE_RADIUS,
  );
  const loadedPages = new Set(
    storyline.chapters.map((chapter) => chapter.pageNumber),
  );
  const missingPages: number[] = [];

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    if (!loadedPages.has(pageNumber)) {
      missingPages.push(pageNumber);
    }
  }

  return missingPages;
}

function clampPage(pageNumber: number, chapterCount: number): number {
  return Math.min(Math.max(pageNumber, 1), chapterCount);
}
