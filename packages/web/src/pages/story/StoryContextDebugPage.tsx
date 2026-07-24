import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { StoryContextSnapshot, StorylineId } from "@kimiko/schema";
import { getStorylineContext } from "../../story/storylineApi";
import { StoryContextDebugView } from "./StoryContextDebugView";

type StoryContextDebugPageStatus =
  "loading" | "success" | "empty" | "failed" | "notFound";

interface StoryContextDebugPageProps {
  readonly storylineId: StorylineId;
}

const defaultContextErrorMessage = "获取故事上下文失败，请稍后重试";

export function StoryContextDebugPage({
  storylineId,
}: StoryContextDebugPageProps): JSX.Element {
  const navigate = useNavigate();
  const isMountedRef = useRef<boolean>(false);
  const requestIdRef = useRef<number>(0);
  const [status, setStatus] = useState<StoryContextDebugPageStatus>("loading");
  const [context, setContext] = useState<StoryContextSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState(defaultContextErrorMessage);

  const storyPath = `/storylines/${encodeURIComponent(storylineId)}`;

  const loadContext = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus("loading");
    setContext(null);
    setErrorMessage(defaultContextErrorMessage);

    const result = await getStorylineContext(storylineId);
    if (!isMountedRef.current || requestIdRef.current !== requestId) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "notFound") {
      setErrorMessage(result.message);
      setStatus("notFound");
      return;
    }

    if (result.status === "failed") {
      setErrorMessage(result.message);
      setStatus("failed");
      return;
    }

    setContext(result.context);
    setStatus(result.context === null ? "empty" : "success");
  }, [navigate, storylineId]);

  useEffect(() => {
    isMountedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void loadContext();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      isMountedRef.current = false;
    };
  }, [loadContext]);

  function handleBackToStory(): void {
    void navigate(storyPath);
  }

  function handleBackToList(): void {
    void navigate("/storylines");
  }

  return (
    <main
      aria-label="故事上下文调试"
      className="min-h-svh px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:py-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <header className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
          <p className="m-0 text-sm font-semibold text-(--accent)">
            StoryAgent Debug
          </p>
          <h1 className="mt-1 mb-0 text-2xl font-bold text-(--text-h)">
            故事上下文调试
          </h1>
          <p className="mt-2 mb-5 text-sm leading-6 text-(--text)">
            只读查看当前服务端保存的 StoryContextSnapshot。
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className="min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h)"
              onClick={handleBackToStory}
              type="button"
            >
              返回故事
            </button>
            <button
              className="min-h-10 rounded-full border-0 bg-(--accent) px-4 py-2 text-sm font-bold text-white"
              onClick={() => {
                void loadContext();
              }}
              type="button"
            >
              刷新
            </button>
          </div>
        </header>

        {status === "loading" ? <ContextLoading /> : null}

        {status === "empty" ? (
          <ContextEmpty onBackToStory={handleBackToStory} />
        ) : null}

        {status === "failed" ? (
          <ContextError
            message={errorMessage}
            onRetry={() => {
              void loadContext();
            }}
            title="故事上下文加载失败"
          />
        ) : null}

        {status === "notFound" ? (
          <ContextError
            message="故事线不存在或已不可用。"
            onRetry={() => {
              void loadContext();
            }}
            secondaryAction={
              <button
                className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h)"
                onClick={handleBackToList}
                type="button"
              >
                返回列表
              </button>
            }
            title="故事线不可用"
          />
        ) : null}

        {status === "success" && context !== null ? (
          <StoryContextDebugView context={context} />
        ) : null}
      </section>
    </main>
  );
}

function ContextLoading(): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-8 text-center shadow-(--shadow)"
      role="status"
    >
      <p className="m-0 text-base text-(--text)">正在获取故事上下文...</p>
    </section>
  );
}

function ContextEmpty({
  onBackToStory,
}: {
  readonly onBackToStory: () => void;
}): JSX.Element {
  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-(--shadow) md:p-8">
      <h2 className="m-0 text-xl font-bold text-(--text-h)">暂无故事上下文</h2>
      <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">
        下一次成功生成后，服务端会建立 StoryContextSnapshot。
      </p>
      <button
        className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white"
        onClick={onBackToStory}
        type="button"
      >
        返回故事
      </button>
    </section>
  );
}

function ContextError({
  message,
  onRetry,
  secondaryAction,
  title,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly secondaryAction?: JSX.Element | undefined;
  readonly title: string;
}): JSX.Element {
  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-(--shadow) md:p-8">
      <h2 className="m-0 text-xl font-bold text-(--text-h)">{title}</h2>
      <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">{message}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white"
          onClick={onRetry}
          type="button"
        >
          重试
        </button>
        {secondaryAction}
      </div>
    </section>
  );
}
