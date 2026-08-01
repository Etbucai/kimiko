import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";

interface StoryPageHeaderProps {
  readonly isCopyDisabled: boolean;
  readonly onBackToList: () => void;
  readonly onCopyStoryline: () => void;
  readonly onOpenContext: () => void;
  readonly showStoryActions: boolean;
  readonly title: string;
}

export function StoryPageHeader({
  isCopyDisabled,
  onBackToList,
  onCopyStoryline,
  onOpenContext,
  showStoryActions,
  title,
}: StoryPageHeaderProps): JSX.Element {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent): void {
      if (
        event.target instanceof Node &&
        !menuContainerRef.current?.contains(event.target)
      ) {
        setIsMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  return (
    <header className="z-10 box-border h-[calc(4.5rem+env(safe-area-inset-top))] shrink-0 border-b border-[var(--border)] bg-[var(--panel-bg)] px-4 pt-[env(safe-area-inset-top)] shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur md:px-6">
      <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold text-[var(--accent)]">
            StoryAgent
          </p>
          <h1
            className="mt-0.5 mb-0 truncate text-lg font-bold text-[var(--text-h)] md:text-xl"
            title={title}
          >
            {title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showStoryActions ? (
            <div className="relative" ref={menuContainerRef}>
              <button
                aria-expanded={isMenuOpen}
                aria-haspopup="menu"
                aria-label="更多故事操作"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-(--border) bg-transparent text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
                onClick={() => setIsMenuOpen((current) => !current)}
                type="button"
              >
                <Ellipsis aria-hidden size={22} strokeWidth={2.3} />
              </button>

              {isMenuOpen ? (
                <div
                  aria-label="故事操作"
                  className="absolute top-12 right-0 z-30 flex min-w-36 flex-col overflow-hidden rounded-2xl border border-(--border) bg-(--panel-bg) p-1.5 shadow-(--shadow)"
                  role="menu"
                >
                  <button
                    className="min-h-10 rounded-xl border-0 bg-transparent px-3 py-2 text-left text-sm font-bold text-(--text-h) transition-colors hover:bg-(--accent-bg) disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    disabled={isCopyDisabled}
                    onClick={() => {
                      setIsMenuOpen(false);
                      onCopyStoryline();
                    }}
                    role="menuitem"
                    title={
                      isCopyDisabled
                        ? "当前故事正在处理中，暂时不能复制"
                        : undefined
                    }
                    type="button"
                  >
                    复制故事
                  </button>
                  <button
                    className="min-h-10 rounded-xl border-0 bg-transparent px-3 py-2 text-left text-sm font-bold text-(--text-h) transition-colors hover:bg-(--accent-bg)"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onOpenContext();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    上下文
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          <button
            className="min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            onClick={onBackToList}
            type="button"
          >
            返回列表
          </button>
        </div>
      </div>
    </header>
  );
}
