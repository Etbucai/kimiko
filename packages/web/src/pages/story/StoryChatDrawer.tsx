import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";

interface StoryChatDrawerProps {
  readonly chapterNumber: number;
  readonly error?: string | undefined;
  readonly isSubmitting: boolean;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly value: string;
}

export function StoryChatDrawer({
  chapterNumber,
  error,
  isSubmitting,
  onChange,
  onClose,
  onSubmit,
  value,
}: StoryChatDrawerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const errorId = "story-chat-drawer-error";

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [chapterNumber]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose]);

  return (
    <>
      <button
        aria-label="关闭聊天输入抽屉"
        className="fixed inset-0 z-30 cursor-default border-0 bg-black/20 disabled:cursor-wait"
        disabled={isSubmitting}
        onClick={onClose}
        type="button"
      />
      <section
        aria-label="与 AI 聊聊"
        className="fixed inset-x-0 bottom-0 z-40 rounded-t-3xl border border-(--border) bg-(--panel-bg) px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-10px_24px_rgba(0,0,0,0.12)] backdrop-blur md:px-6"
      >
        <form
          className="mx-auto flex w-full max-w-3xl flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="m-0 text-base font-bold text-(--text-h)">
                与 AI 聊聊
              </h2>
              <p className="mt-1 mb-0 text-xs text-(--text)">
                正在讨论第 {chapterNumber} 章
              </p>
            </div>
            <button
              aria-label="关闭聊天输入抽屉"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-(--border) bg-transparent text-(--text-h) transition-[border-color,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:border-(--accent-border) disabled:cursor-wait disabled:opacity-40"
              disabled={isSubmitting}
              onClick={onClose}
              type="button"
            >
              <X aria-hidden size={20} strokeWidth={2.3} />
            </button>
          </div>

          <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
            想聊的话题
            <textarea
              aria-describedby={error !== undefined ? errorId : undefined}
              aria-invalid={error !== undefined}
              className="box-border max-h-48 min-h-28 w-full resize-y rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-base leading-7 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-wait disabled:opacity-60"
              disabled={isSubmitting}
              maxLength={4_000}
              onChange={(event) => onChange(event.currentTarget.value)}
              placeholder="可以讨论情节、人物、伏笔、续写方向，或询问任何与当前故事有关的问题"
              ref={textareaRef}
              value={value}
            />
          </label>

          {error !== undefined ? (
            <p
              className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm text-(--danger)"
              id={errorId}
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <button
            className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-wait disabled:opacity-60"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "正在准备..." : "发送给 AI"}
          </button>
        </form>
      </section>
    </>
  );
}
