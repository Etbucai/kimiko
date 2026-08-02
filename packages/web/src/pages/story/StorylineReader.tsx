import type { JSX } from "react";
import { useEffect, useMemo } from "react";
import type {
  StorylineChapter,
  StorylineSegmentId,
  StorylineSnapshot,
} from "@kimiko/schema";
import { StoryChatBlock } from "./StoryChatBlock";
import type { StoryChatEntry } from "./storyChatTypes";

export interface RewriteDraftState {
  readonly targetSegmentId: StorylineSegmentId;
  readonly text: string;
}

export interface StorylineReaderViewportState {
  readonly currentPageIndex: number;
  readonly isViewingLatestPage: boolean;
  readonly pageCount: number;
  readonly pageLabel: string;
}

interface StorylineDialogueSegmentView {
  readonly id: StorylineSegmentId;
  readonly text: string;
}

type StorylineReaderPage =
  | Readonly<{
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "initial";
      pageNumber: number;
      text: string;
    }>
  | Readonly<{
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "append";
      pageNumber: number;
      text: string;
    }>
  | Readonly<{
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      id: "temporary-append";
      kind: "temporaryAppend";
      pageNumber: number;
      text: string;
    }>;

type StorylineReaderPageBuilder =
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "initial";
      pageNumber: number;
      text: string;
    }
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "append";
      pageNumber: number;
      text: string;
    }
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: "temporary-append";
      kind: "temporaryAppend";
      pageNumber: number;
      text: string;
    };

interface StorylineReaderProps {
  chatEntries: readonly StoryChatEntry[];
  initialInstruction?: string | undefined;
  onChatExpandedChange: (chatId: string, expanded: boolean) => void;
  onChatReasoningExpandedChange: (
    chatId: string,
    expanded: boolean,
  ) => void;
  onViewportChange: (state: StorylineReaderViewportState) => void;
  pageIndex: number | null;
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
  temporaryDialogueText: string;
  temporaryDialogueVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "updatingContext" | null;
}

export function StorylineReader({
  chatEntries,
  initialInstruction,
  onChatExpandedChange,
  onChatReasoningExpandedChange,
  onViewportChange,
  pageIndex,
  storyline,
  temporaryAppendText,
  temporaryAppendVisible,
  temporaryDialogueText,
  temporaryDialogueVisible,
  temporaryRewrite,
  temporaryTextStatus,
}: StorylineReaderProps): JSX.Element {
  const pages = useMemo(
    () =>
      buildReaderPages({
        chapters: storyline.chapters,
        chapterCount: storyline.chapterCount,
        temporaryAppendText,
        temporaryAppendVisible,
      }),
    [
      storyline.chapterCount,
      storyline.chapters,
      temporaryAppendText,
      temporaryAppendVisible,
    ],
  );
  const pageCount = storyline.chapterCount + (temporaryAppendVisible ? 1 : 0);
  const safeCurrentPageIndex =
    pageIndex === null
      ? getLastPageIndex(pageCount)
      : clampPageIndex(pageIndex, pageCount);
  const currentPage = pages.find(
    (page) => page.pageNumber === safeCurrentPageIndex + 1,
  );
  const pageLabel = formatPageLabel(
    currentPage,
    safeCurrentPageIndex,
    pageCount,
  );

  useEffect(() => {
    onViewportChange({
      currentPageIndex: safeCurrentPageIndex,
      isViewingLatestPage:
        pageCount > 0 && safeCurrentPageIndex === pageCount - 1,
      pageCount,
      pageLabel,
    });
  }, [onViewportChange, pageCount, pageLabel, safeCurrentPageIndex]);

  return (
    <article aria-label="故事正文">
      {currentPage !== undefined ? (
        <StorylinePagePanel
          chatEntries={chatEntries}
          initialInstruction={initialInstruction}
          onChatExpandedChange={onChatExpandedChange}
          onChatReasoningExpandedChange={onChatReasoningExpandedChange}
          page={currentPage}
          pageIndex={safeCurrentPageIndex}
          pageTotal={pageCount}
          temporaryDialogueText={temporaryDialogueText}
          temporaryDialogueVisible={
            temporaryDialogueVisible &&
            safeCurrentPageIndex === storyline.chapterCount - 1
          }
          temporaryRewrite={temporaryRewrite}
          temporaryTextStatus={temporaryTextStatus}
        />
      ) : null}
    </article>
  );
}

interface BuildReaderPagesInput {
  chapters: readonly StorylineChapter[];
  chapterCount: number;
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
}

function buildReaderPages({
  chapters,
  chapterCount,
  temporaryAppendText,
  temporaryAppendVisible,
}: BuildReaderPagesInput): StorylineReaderPage[] {
  const pageBuilders: StorylineReaderPageBuilder[] = [];

  for (const chapter of chapters) {
    let pageBuilder: StorylineReaderPageBuilder | undefined;

    for (const segment of chapter.segments) {
      if (segment.type === "initial") {
        pageBuilder = {
          dialogueSegments: [],
          id: segment.id,
          kind: "initial",
          pageNumber: chapter.pageNumber,
          text: segment.text,
        };
        continue;
      }

      if (segment.generationMode === "append") {
        pageBuilder = {
          dialogueSegments: [],
          id: segment.id,
          kind: "append",
          pageNumber: chapter.pageNumber,
          text: segment.text,
        };
        continue;
      }

      pageBuilder?.dialogueSegments.push({
        id: segment.id,
        text: segment.text,
      });
    }

    if (pageBuilder !== undefined) {
      pageBuilders.push(pageBuilder);
    }
  }

  if (temporaryAppendVisible) {
    pageBuilders.push({
      dialogueSegments: [],
      id: "temporary-append",
      kind: "temporaryAppend",
      pageNumber: chapterCount + 1,
      text: temporaryAppendText,
    });
  }

  return pageBuilders.map((page) => ({
    ...page,
    dialogueSegments: [...page.dialogueSegments],
  }));
}

interface StorylinePagePanelProps {
  chatEntries: readonly StoryChatEntry[];
  initialInstruction?: string | undefined;
  onChatExpandedChange: (chatId: string, expanded: boolean) => void;
  onChatReasoningExpandedChange: (
    chatId: string,
    expanded: boolean,
  ) => void;
  page: StorylineReaderPage;
  pageIndex: number;
  pageTotal: number;
  temporaryDialogueText: string;
  temporaryDialogueVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "updatingContext" | null;
}

function StorylinePagePanel({
  chatEntries,
  initialInstruction,
  onChatExpandedChange,
  onChatReasoningExpandedChange,
  page,
  pageIndex,
  pageTotal,
  temporaryDialogueText,
  temporaryDialogueVisible,
  temporaryRewrite,
  temporaryTextStatus,
}: StorylinePagePanelProps): JSX.Element {
  return (
    <section
      aria-label={formatPageLabel(page, pageIndex, pageTotal)}
      className="box-border w-full min-w-0"
    >
      <div className="box-border flex w-full min-w-0 flex-col gap-4">
        <SegmentDivider label={getPageKindLabel(page)} />
        <StoryText text={page.text} />
        {page.kind === "initial" && initialInstruction !== undefined ? (
          <section
            aria-label="已提交的续写指令"
            className="flex flex-col gap-4"
          >
            <SegmentDivider label="续写指令" />
            <StoryText text={initialInstruction} />
          </section>
        ) : null}
        {temporaryRewrite?.targetSegmentId === page.id ? (
          <TemporaryRewriteBlock
            status={temporaryTextStatus}
            text={temporaryRewrite.text}
          />
        ) : null}
        {page.dialogueSegments.map((dialogue) => (
          <section
            aria-label="互动正文"
            className="flex flex-col gap-4"
            key={dialogue.id}
          >
            <SegmentDivider label="互动" />
            <StoryText text={dialogue.text} />
            {temporaryRewrite?.targetSegmentId === dialogue.id ? (
              <TemporaryRewriteBlock
                status={temporaryTextStatus}
                text={temporaryRewrite.text}
              />
            ) : null}
          </section>
        ))}
        {chatEntries.map((entry) => (
          <StoryChatBlock
            entry={entry}
            key={entry.id}
            onExpandedChange={(expanded) =>
              onChatExpandedChange(entry.id, expanded)
            }
            onReasoningExpandedChange={(expanded) =>
              onChatReasoningExpandedChange(entry.id, expanded)
            }
          />
        ))}
        {temporaryDialogueVisible ? (
          <section aria-label="正在生成的互动" className="flex flex-col gap-4">
            <SegmentDivider label="互动中" />
            <StoryText text={temporaryDialogueText} />
            <TemporaryStatus status={temporaryTextStatus} />
          </section>
        ) : null}
        {page.kind === "temporaryAppend" ? (
          <TemporaryStatus status={temporaryTextStatus} />
        ) : null}
      </div>
    </section>
  );
}

function TemporaryRewriteBlock({
  status,
  text,
}: {
  status: "streaming" | "updatingContext" | null;
  text: string;
}): JSX.Element {
  return (
    <section aria-label="正在重写的正文" className="flex flex-col gap-4">
      <SegmentDivider label="重写中" />
      <StoryText text={text} />
      <TemporaryStatus status={status} />
    </section>
  );
}

function StoryText({ text }: { text: string }): JSX.Element {
  if (text.length === 0) {
    return (
      <p className="m-0 text-base leading-8 text-(--text)">正在连接生成...</p>
    );
  }

  return (
    <p className="m-0 whitespace-pre-wrap text-base leading-8 text-(--text-h)">
      {text}
    </p>
  );
}

function TemporaryStatus({
  status,
}: {
  status: "streaming" | "updatingContext" | null;
}): JSX.Element | null {
  if (status === null) {
    return null;
  }

  return (
    <p className="m-0 text-xs text-(--text)" role="status">
      {status === "streaming" ? "正在生成..." : "正在更新故事上下文..."}
    </p>
  );
}

function getPageKindLabel(page: StorylineReaderPage): string {
  switch (page.kind) {
    case "initial":
      return "初始正文";
    case "append":
      return "续写";
    case "temporaryAppend":
      return "生成中";
  }
}

function formatPageLabel(
  page: StorylineReaderPage | undefined,
  pageIndex: number,
  pageTotal: number,
): string {
  const safeTotal = Math.max(pageTotal, 1);
  const safePageIndex = clampPageIndex(pageIndex, safeTotal);
  const kindLabel = page === undefined ? "故事正文" : getPageKindLabel(page);
  return `第 ${safePageIndex + 1} / ${safeTotal} 章 · ${kindLabel}`;
}

function clampPageIndex(index: number, pageTotal: number): number {
  if (pageTotal <= 0) {
    return 0;
  }

  return Math.min(Math.max(index, 0), pageTotal - 1);
}

function getLastPageIndex(pageTotal: number): number {
  return clampPageIndex(pageTotal - 1, pageTotal);
}

interface SegmentDividerProps {
  label: string;
}

function SegmentDivider({ label }: SegmentDividerProps): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-xs text-(--text)">
      <span className="h-px flex-1 bg-(--border)" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-(--border)" />
    </div>
  );
}
