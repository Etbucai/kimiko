import type { JSX } from "react";

interface StorylineComposerProps {
  disabled: boolean;
  error?: string | undefined;
  isGenerating: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}

export function StorylineComposer({
  disabled,
  error,
  isGenerating,
  onCancel,
  onChange,
  onSubmit,
  value,
}: StorylineComposerProps): JSX.Element {
  const errorId = "story-instruction-error";

  return (
    <form
      className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--border)] bg-[var(--panel-bg)] px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-10px_24px_rgba(0,0,0,0.08)] backdrop-blur md:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (isGenerating) {
          onCancel();
          return;
        }

        onSubmit();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-h)]">
          续写指令
          <textarea
            aria-describedby={error !== undefined ? errorId : undefined}
            aria-invalid={error !== undefined}
            className="box-border max-h-40 min-h-20 w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--input-bg)] px-4 py-3 text-base leading-7 text-[var(--text-h)] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-[var(--text)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70"
            disabled={disabled}
            maxLength={8_000}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="描述接下来要发生的主要情节和人物行动"
            value={value}
          />
        </label>
        {error !== undefined ? (
          <p
            className="m-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
            id={errorId}
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <button
          className="min-h-12 rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:cursor-pointer enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
          type="submit"
        >
          {isGenerating ? "取消生成" : "生成续写"}
        </button>
      </div>
    </form>
  );
}
