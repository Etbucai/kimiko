import type { CSSProperties, JSX, KeyboardEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  StorylineSegment,
  StorylineSegmentId,
  StorylineSnapshot,
} from "@kimiko/schema";

export interface RewriteDraftState {
  readonly targetSegmentId: StorylineSegmentId;
  readonly text: string;
}

export interface StorylineReaderViewportState {
  readonly currentPageIndex: number;
  readonly isViewingLatestPage: boolean;
  readonly pageCount: number;
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
      text: string;
    }>
  | Readonly<{
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "append";
      text: string;
    }>
  | Readonly<{
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      id: "temporary-append";
      kind: "temporaryAppend";
      text: string;
    }>;

type StorylineReaderPageBuilder =
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "initial";
      text: string;
    }
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: StorylineSegmentId;
      kind: "append";
      text: string;
    }
  | {
      dialogueSegments: StorylineDialogueSegmentView[];
      id: "temporary-append";
      kind: "temporaryAppend";
      text: string;
    };

interface StorylineReaderProps {
  onViewportChange: (state: StorylineReaderViewportState) => void;
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
  temporaryDialogueText: string;
  temporaryDialogueVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
}

export function StorylineReader({
  onViewportChange,
  storyline,
  temporaryAppendText,
  temporaryAppendVisible,
  temporaryDialogueText,
  temporaryDialogueVisible,
  temporaryRewrite,
  temporaryTextStatus,
}: StorylineReaderProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pagePanelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastPositionedPageIdentityRef = useRef<string | null>(null);
  const previousTemporaryAppendVisibleRef = useRef(temporaryAppendVisible);
  const pages = useMemo(
    () =>
      buildReaderPages({
        segments: storyline.segments,
        temporaryAppendText,
        temporaryAppendVisible,
      }),
    [storyline.segments, temporaryAppendText, temporaryAppendVisible],
  );
  const pageIdentity = useMemo(
    () =>
      pages
        .map((page) =>
          [
            page.id,
            ...page.dialogueSegments.map((dialogue) => dialogue.id),
          ].join(":"),
        )
        .join("|"),
    [pages],
  );
  const [currentPageIndex, setCurrentPageIndex] = useState(() =>
    getLastPageIndex(pages.length),
  );
  const [scrollerHeight, setScrollerHeight] = useState<number | null>(null);
  const safeCurrentPageIndex = clampPageIndex(currentPageIndex, pages.length);
  const currentPage = pages[safeCurrentPageIndex] ?? pages[0];
  const scrollerStyle = useMemo<CSSProperties | undefined>(
    () =>
      scrollerHeight === null
        ? undefined
        : {
            height: `${scrollerHeight}px`,
          },
    [scrollerHeight],
  );

  const updateScrollerHeight = useCallback((pageIndex: number): void => {
    const panel = pagePanelRefs.current[pageIndex];
    if (panel === null || panel === undefined) {
      setScrollerHeight(null);
      return;
    }

    const nextHeight = Math.ceil(panel.getBoundingClientRect().height);
    setScrollerHeight((previousHeight) =>
      previousHeight === nextHeight ? previousHeight : nextHeight,
    );
  }, []);

  useEffect(() => {
    pagePanelRefs.current.length = pages.length;
  }, [pages.length]);

  useEffect(() => {
    onViewportChange({
      currentPageIndex: safeCurrentPageIndex,
      isViewingLatestPage:
        pages.length > 0 && safeCurrentPageIndex === pages.length - 1,
      pageCount: pages.length,
    });
  }, [onViewportChange, pages.length, safeCurrentPageIndex]);

  useLayoutEffect(() => {
    updateScrollerHeight(safeCurrentPageIndex);
  }, [pages, safeCurrentPageIndex, updateScrollerHeight]);

  useEffect(() => {
    const panel = pagePanelRefs.current[safeCurrentPageIndex];
    if (panel === null || panel === undefined) {
      updateScrollerHeight(safeCurrentPageIndex);
      return;
    }

    if (typeof ResizeObserver === "undefined") {
      updateScrollerHeight(safeCurrentPageIndex);
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      updateScrollerHeight(safeCurrentPageIndex);
    });
    resizeObserver.observe(panel);

    return () => resizeObserver.disconnect();
  }, [safeCurrentPageIndex, updateScrollerHeight]);

  useLayoutEffect(() => {
    if (pages.length === 0) {
      return undefined;
    }

    if (lastPositionedPageIdentityRef.current === pageIdentity) {
      return undefined;
    }

    lastPositionedPageIdentityRef.current = pageIdentity;
    if (scrollToPage(scrollerRef.current, safeCurrentPageIndex, "auto")) {
      return undefined;
    }

    const frameId = requestAnimationFrame(() => {
      scrollToPage(scrollerRef.current, safeCurrentPageIndex, "auto");
    });

    return () => cancelAnimationFrame(frameId);
  }, [pageIdentity, pages.length, safeCurrentPageIndex, storyline.id]);

  useEffect(() => {
    if (!temporaryAppendVisible) {
      return;
    }

    const targetIndex = pages.length - 1;
    requestAnimationFrame(() => {
      setCurrentPageIndex(targetIndex);
      scrollToPage(scrollerRef.current, targetIndex, "smooth");
    });
  }, [pages.length, temporaryAppendVisible]);

  useEffect(() => {
    const wasTemporaryAppendVisible = previousTemporaryAppendVisibleRef.current;
    previousTemporaryAppendVisibleRef.current = temporaryAppendVisible;

    if (!wasTemporaryAppendVisible || temporaryAppendVisible) {
      return;
    }

    const targetIndex = getLastPageIndex(pages.length);
    requestAnimationFrame(() => {
      setCurrentPageIndex(targetIndex);
      scrollToPage(scrollerRef.current, targetIndex, "auto");
    });
  }, [pages.length, temporaryAppendVisible]);

  useEffect(() => {
    const rewriteTargetSegmentId = temporaryRewrite?.targetSegmentId;
    if (rewriteTargetSegmentId === undefined) {
      return;
    }

    const targetIndex = findPageIndexBySegmentId(pages, rewriteTargetSegmentId);
    if (targetIndex < 0) {
      return;
    }

    requestAnimationFrame(() => {
      setCurrentPageIndex(targetIndex);
      scrollToPage(scrollerRef.current, targetIndex, "auto");
    });
  }, [pages, temporaryRewrite?.targetSegmentId]);

  function handleScroll(): void {
    const scroller = scrollerRef.current;
    if (scroller === null || scroller.clientWidth <= 0) {
      return;
    }

    const nextIndex = clampPageIndex(
      Math.round(scroller.scrollLeft / scroller.clientWidth),
      pages.length,
    );
    setCurrentPageIndex(nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = clampPageIndex(
      currentPageIndex + direction,
      pages.length,
    );
    if (nextIndex === currentPageIndex) {
      return;
    }

    if (scrollToPage(scrollerRef.current, nextIndex, "auto")) {
      setCurrentPageIndex(nextIndex);
    }
  }

  return (
    <article
      aria-label="故事正文"
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-4 shadow-(--shadow) outline-none focus:border-(--accent-border) md:p-5"
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-(--text)">
        <span>
          {formatPageLabel(currentPage, safeCurrentPageIndex, pages.length)}
        </span>
        <span>左右滑动切换</span>
      </div>
      <div
        ref={scrollerRef}
        className="flex snap-x snap-mandatory items-start gap-0 overflow-x-auto overflow-y-hidden overscroll-x-contain"
        onScroll={handleScroll}
        style={scrollerStyle}
      >
        {pages.map((page, index) => (
          <StorylinePagePanel
            key={page.id}
            page={page}
            pageIndex={index}
            pageTotal={pages.length}
            panelRef={(element) => {
              pagePanelRefs.current[index] = element;
            }}
            temporaryDialogueText={temporaryDialogueText}
            temporaryDialogueVisible={
              temporaryDialogueVisible && index === pages.length - 1
            }
            temporaryRewrite={temporaryRewrite}
            temporaryTextStatus={temporaryTextStatus}
          />
        ))}
      </div>
    </article>
  );
}

interface BuildReaderPagesInput {
  segments: readonly StorylineSegment[];
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
}

function buildReaderPages({
  segments,
  temporaryAppendText,
  temporaryAppendVisible,
}: BuildReaderPagesInput): StorylineReaderPage[] {
  const pageBuilders: StorylineReaderPageBuilder[] = [];

  for (const segment of segments) {
    if (segment.type === "initial") {
      pageBuilders.push({
        dialogueSegments: [],
        id: segment.id,
        kind: "initial",
        text: segment.text,
      });
      continue;
    }

    if (segment.generationMode === "dialogue") {
      const latestPage = pageBuilders.at(-1);
      if (latestPage === undefined) {
        continue;
      }

      latestPage.dialogueSegments.push({
        id: segment.id,
        text: segment.text,
      });
      continue;
    }

    pageBuilders.push({
      dialogueSegments: [],
      id: segment.id,
      kind: "append",
      text: segment.text,
    });
  }

  if (temporaryAppendVisible) {
    pageBuilders.push({
      dialogueSegments: [],
      id: "temporary-append",
      kind: "temporaryAppend",
      text: temporaryAppendText,
    });
  }

  return pageBuilders.map((page) => ({
    ...page,
    dialogueSegments: [...page.dialogueSegments],
  }));
}

interface StorylinePagePanelProps {
  page: StorylineReaderPage;
  pageIndex: number;
  pageTotal: number;
  panelRef: (element: HTMLDivElement | null) => void;
  temporaryDialogueText: string;
  temporaryDialogueVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
}

function StorylinePagePanel({
  page,
  pageIndex,
  pageTotal,
  panelRef,
  temporaryDialogueText,
  temporaryDialogueVisible,
  temporaryRewrite,
  temporaryTextStatus,
}: StorylinePagePanelProps): JSX.Element {
  return (
    <section
      aria-label={formatPageLabel(page, pageIndex, pageTotal)}
      className="box-border w-full min-w-0 flex-none snap-center px-1"
    >
      <div
        ref={panelRef}
        className="box-border flex w-full min-w-0 flex-col gap-4 rounded-3xl border border-(--border) bg-(--panel-bg) p-5 md:p-7"
      >
        <SegmentDivider label={getPageKindLabel(page)} />
        <StoryText text={page.text} />
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
  status: "streaming" | "summarizing" | null;
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
  status: "streaming" | "summarizing" | null;
}): JSX.Element | null {
  if (status === null) {
    return null;
  }

  return (
    <p className="m-0 text-xs text-(--text)" role="status">
      {status === "streaming" ? "正在生成..." : "正在记录角色摘要..."}
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
  return `第 ${safePageIndex + 1} / ${safeTotal} 页 · ${kindLabel}`;
}

function findPageIndexBySegmentId(
  pages: readonly StorylineReaderPage[],
  segmentId: StorylineSegmentId,
): number {
  return pages.findIndex(
    (page) =>
      page.id === segmentId ||
      page.dialogueSegments.some((dialogue) => dialogue.id === segmentId),
  );
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

function scrollToPage(
  scroller: HTMLDivElement | null,
  pageIndex: number,
  behavior: ScrollBehavior,
): boolean {
  if (scroller === null) {
    return false;
  }

  if (scroller.clientWidth <= 0) {
    return false;
  }

  scroller.scrollTo({
    behavior,
    left: pageIndex * scroller.clientWidth,
  });
  return true;
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
