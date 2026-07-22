import type { JSX } from "react";

interface StorylineRestoreErrorProps {
  message: string;
  onRetry: () => void;
  title?: string | undefined;
}

export function StorylineRestoreError({
  message,
  onRetry,
  title = "故事线恢复失败",
}: StorylineRestoreErrorProps): JSX.Element {
  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-6 text-center shadow-[var(--shadow)] md:p-8">
      <h1 className="m-0 text-xl font-bold text-[var(--text-h)]">{title}</h1>
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
