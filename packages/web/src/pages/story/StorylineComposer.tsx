import type { JSX } from "react";

export type StorylineComposerMode = "append" | "rewrite";

const textareaClassName =
  "box-border min-h-[calc(12rem+2px)] w-full resize-y rounded-3xl border border-(--border) bg-(--input-bg) px-4 py-4 text-base leading-8 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 [field-sizing:content] placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

interface StorylineComposerProps {
  disabled: boolean;
  error?: string | undefined;
  isGenerating: boolean;
  mode: StorylineComposerMode;
  modeHint?: string | undefined;
  onCancelGeneration: () => void;
  onCancelRewrite: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}

export function StorylineComposer({
  disabled,
  error,
  isGenerating,
  mode,
  modeHint,
  onCancelGeneration,
  onCancelRewrite,
  onChange,
  onSubmit,
  value,
}: StorylineComposerProps): JSX.Element {
  const errorId = "story-instruction-error";
  const label = mode === "rewrite" ? "重写指令" : "续写指令";
  const placeholder =
    mode === "rewrite"
      ? "例如：不要转变场景，文风更加轻快，增加对气味的描写"
      : "描述接下来要发生的主要情节和人物行动";
  const submitText = isGenerating
    ? "取消生成"
    : mode === "rewrite"
      ? "生成重写"
      : "生成续写";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (isGenerating) {
          onCancelGeneration();
          return;
        }

        onSubmit();
      }}
    >
      {modeHint !== undefined ? (
        <p className="m-0 text-xs font-semibold text-(--accent)">
          {modeHint}
        </p>
      ) : null}
      <label className="flex flex-col gap-4">
        <span className="text-sm font-semibold text-(--text)">{label}</span>
        <textarea
          aria-describedby={error !== undefined ? errorId : undefined}
          aria-invalid={error !== undefined}
          className={textareaClassName}
          disabled={disabled}
          maxLength={8_000}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          rows={5}
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
      <div className="flex flex-col gap-3">
        <button
          className="min-h-12 rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:cursor-pointer enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
          type="submit"
        >
          {submitText}
        </button>
        {mode === "rewrite" && !isGenerating ? (
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            onClick={onCancelRewrite}
            type="button"
          >
            取消重写
          </button>
        ) : null}
      </div>
    </form>
  );
}
