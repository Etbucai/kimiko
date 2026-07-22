import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { StorylineListItem } from "@kimiko/schema";
import { listStorylines } from "../../story/storylineApi";

type StorylineListPageStatus = "loading" | "ready" | "empty" | "failed";

const defaultListErrorMessage = "加载故事列表失败，请稍后重试";

export function StorylineListPage(): JSX.Element {
  const navigate = useNavigate();
  const isMountedRef = useRef<boolean>(false);
  const [status, setStatus] = useState<StorylineListPageStatus>("loading");
  const [storylines, setStorylines] = useState<readonly StorylineListItem[]>(
    [],
  );
  const [errorMessage, setErrorMessage] = useState(defaultListErrorMessage);

  const loadStorylines = useCallback(async (): Promise<void> => {
    setStatus("loading");
    setErrorMessage(defaultListErrorMessage);

    const result = await listStorylines();
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "failed") {
      setStorylines([]);
      setErrorMessage(result.message);
      setStatus("failed");
      return;
    }

    setStorylines(result.storylines);
    setStatus(result.storylines.length === 0 ? "empty" : "ready");
  }, [navigate]);

  useEffect(() => {
    isMountedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void loadStorylines();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      isMountedRef.current = false;
    };
  }, [loadStorylines]);

  return (
    <main
      aria-label="故事列表"
      className="min-h-svh px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:py-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <StorylineListHeader />

        {status === "loading" ? <StorylineListLoading /> : null}

        {status === "failed" ? (
          <StorylineListError
            message={errorMessage}
            onRetry={() => {
              void loadStorylines();
            }}
          />
        ) : null}

        {status === "empty" ? <StorylineListEmpty /> : null}

        {status === "ready" ? (
          <div className="flex flex-col gap-3">
            {storylines.map((storyline) => (
              <StorylineListCard key={storyline.id} storyline={storyline} />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function StorylineListHeader(): JSX.Element {
  return (
    <header className="flex flex-col gap-3 rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:flex-row md:items-center md:justify-between md:p-6">
      <div>
        <p className="m-0 text-sm font-semibold text-[var(--accent)]">
          StoryAgent
        </p>
        <h1 className="mt-1 mb-0 text-2xl font-bold text-[var(--text-h)]">
          故事列表
        </h1>
      </div>
      <Link
        className="inline-flex min-h-11 items-center justify-center rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white no-underline transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        to="/storylines/new"
      >
        新故事
      </Link>
    </header>
  );
}

function StorylineListLoading(): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center shadow-[var(--shadow)]"
      role="status"
    >
      <p className="m-0 text-base text-[var(--text)]">正在加载故事列表...</p>
    </section>
  );
}

interface StorylineListErrorProps {
  message: string;
  onRetry: () => void;
}

function StorylineListError({
  message,
  onRetry,
}: StorylineListErrorProps): JSX.Element {
  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-6 text-center shadow-[var(--shadow)] md:p-8">
      <h2 className="m-0 text-xl font-bold text-[var(--text-h)]">
        故事列表加载失败
      </h2>
      <p className="mt-3 mb-6 text-sm leading-6 text-[var(--text)]">
        {message}
      </p>
      <button
        className="min-h-11 rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        onClick={onRetry}
        type="button"
      >
        重试
      </button>
    </section>
  );
}

function StorylineListEmpty(): JSX.Element {
  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-6 text-center shadow-[var(--shadow)] md:p-8">
      <h2 className="m-0 text-xl font-bold text-[var(--text-h)]">
        还没有故事线
      </h2>
      <p className="mt-3 mb-6 text-sm leading-6 text-[var(--text)]">
        创建第一条故事线后，它会出现在这里。
      </p>
      <Link
        className="inline-flex min-h-11 items-center justify-center rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white no-underline transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        to="/storylines/new"
      >
        新故事
      </Link>
    </section>
  );
}

interface StorylineListCardProps {
  storyline: StorylineListItem;
}

function StorylineListCard({
  storyline,
}: StorylineListCardProps): JSX.Element {
  return (
    <Link
      className="group rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 text-[var(--text)] no-underline shadow-[var(--shadow)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-[var(--accent-border)] md:p-6"
      to={`/storylines/${encodeURIComponent(storyline.id)}`}
    >
      <article className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <h2 className="m-0 text-lg font-bold text-[var(--text-h)]">
            {storyline.title}
          </h2>
          <time
            className="shrink-0 text-xs text-[var(--text)]"
            dateTime={storyline.updatedAt}
          >
            {formatUpdatedAt(storyline.updatedAt)}
          </time>
        </div>
        <p className="m-0 line-clamp-3 text-sm leading-6 text-[var(--text)]">
          {storyline.preview}
        </p>
        <p className="m-0 text-xs font-semibold text-[var(--accent)]">
          共 {storyline.segmentCount} 段
        </p>
      </article>
    </Link>
  );
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
