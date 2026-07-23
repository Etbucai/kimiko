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

type StorylineReaderPage =
  | Readonly<{
      id: StorylineSegmentId;
      kind: "initial";
      text: string;
    }>
  | Readonly<{
      canRewrite: boolean;
      id: StorylineSegmentId;
      kind: "generated";
      text: string;
    }>
  | Readonly<{
      id: "temporary-append";
      kind: "temporaryAppend";
      text: string;
    }>;

interface StorylineReaderProps {
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
  canRewrite: boolean;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
}

export function StorylineReader({
  storyline,
  temporaryAppendText,
  temporaryAppendVisible,
  temporaryRewrite,
  temporaryTextStatus,
  canRewrite,
  onStartRewrite,
}: StorylineReaderProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pagePanelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastPositionedPageIdentityRef = useRef<string | null>(null);
  const pages = useMemo(
    () =>
      buildReaderPages({
        canRewrite,
        segments: storyline.segments,
        temporaryAppendText,
        temporaryAppendVisible,
      }),
    [canRewrite, storyline.segments, temporaryAppendText, temporaryAppendVisible],
  );
  const pageIdentity = useMemo(
    () => pages.map((page) => String(page.id)).join("|"),
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
    const rewriteTargetSegmentId = temporaryRewrite?.targetSegmentId;
    if (rewriteTargetSegmentId === undefined) {
      return;
    }

    const targetIndex = pages.findIndex(
      (page) => page.kind === "generated" && page.id === rewriteTargetSegmentId,
    );
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
    const nextIndex = clampPageIndex(currentPageIndex + direction, pages.length);
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
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-4 shadow-[var(--shadow)] outline-none focus:border-[var(--accent-border)] md:p-5"
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-[var(--text)]">
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
            temporaryRewrite={temporaryRewrite}
            temporaryTextStatus={temporaryTextStatus}
            panelRef={(element) => {
              pagePanelRefs.current[index] = element;
            }}
            onStartRewrite={onStartRewrite}
          />
        ))}
      </div>
    </article>
  );
}

interface BuildReaderPagesInput {
  canRewrite: boolean;
  segments: readonly StorylineSegment[];
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
}

function buildReaderPages({
  canRewrite,
  segments,
  temporaryAppendText,
  temporaryAppendVisible,
}: BuildReaderPagesInput): StorylineReaderPage[] {
  const latestGeneratedSegmentId = getLatestGeneratedSegmentId(segments);
  const pages: StorylineReaderPage[] = segments.map((segment) => {
    if (segment.type === "initial") {
      return {
        id: segment.id,
        kind: "initial",
        text: segment.text,
      };
    }

    return {
      canRewrite: canRewrite && segment.id === latestGeneratedSegmentId,
      id: segment.id,
      kind: "generated",
      text: segment.text,
    };
  });

  if (temporaryAppendVisible) {
    pages.push({
      id: "temporary-append",
      kind: "temporaryAppend",
      text: temporaryAppendText,
    });
  }

  return pages;
}

function getLatestGeneratedSegmentId(
  segments: readonly StorylineSegment[],
): StorylineSegmentId | null {
  const latestGeneratedSegment = [...segments]
    .reverse()
    .find((segment) => segment.type === "generated");

  return latestGeneratedSegment?.id ?? null;
}

interface StorylinePagePanelProps {
  page: StorylineReaderPage;
  pageIndex: number;
  pageTotal: number;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
  panelRef: (element: HTMLDivElement | null) => void;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
}

function StorylinePagePanel({
  page,
  pageIndex,
  pageTotal,
  temporaryRewrite,
  temporaryTextStatus,
  panelRef,
  onStartRewrite,
}: StorylinePagePanelProps): JSX.Element {
  return (
    <section
      aria-label={formatPageLabel(page, pageIndex, pageTotal)}
      className="box-border w-full min-w-0 flex-none snap-center px-1"
    >
      <div
        ref={panelRef}
        className="box-border flex w-full min-w-0 flex-col gap-4 rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 md:p-7"
      >
        <SegmentDivider label={getPageKindLabel(page)} />
        {page.text.length > 0 ? (
          <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
            {page.text}
          </p>
        ) : (
          <p className="m-0 text-base leading-8 text-[var(--text)]">
            正在连接生成...
          </p>
        )}
        {page.kind === "generated" && page.canRewrite ? (
          <div className="flex justify-end">
            <button
              className="rounded-full border border-[var(--border)] bg-transparent px-3 py-1 text-xs font-semibold text-[var(--text-h)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-[var(--accent-border)]"
              onClick={() => onStartRewrite(page.id)}
              type="button"
            >
              重写
            </button>
          </div>
        ) : null}
        {temporaryRewrite?.targetSegmentId === page.id ? (
          <section aria-label="正在重写的正文" className="flex flex-col gap-4">
            <SegmentDivider label="重写中" />
            {temporaryRewrite.text.length > 0 ? (
              <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
                {temporaryRewrite.text}
              </p>
            ) : (
              <p className="m-0 text-base leading-8 text-[var(--text)]">
                正在连接生成...
              </p>
            )}
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

function TemporaryStatus({
  status,
}: {
  status: "streaming" | "summarizing" | null;
}): JSX.Element | null {
  if (status === null) {
    return null;
  }

  return (
    <p className="m-0 text-xs text-[var(--text)]" role="status">
      {status === "streaming" ? "正在生成..." : "正在记录角色摘要..."}
    </p>
  );
}

function getPageKindLabel(page: StorylineReaderPage): string {
  switch (page.kind) {
    case "initial":
      return "初始正文";
    case "generated":
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
    <div className="flex items-center gap-3 text-xs text-[var(--text)]">
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}
