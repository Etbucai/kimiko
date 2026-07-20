import type { JSX } from "react";

interface StoryInitialInputProps {
  disabled: boolean;
  error?: string | undefined;
  onChange: (value: string) => void;
  value: string;
}

const textareaClassName =
  "box-border min-h-56 w-full resize-y rounded-3xl border border-[var(--border)] bg-[var(--input-bg)] px-4 py-4 text-base leading-8 text-[var(--text-h)] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-[var(--text)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

export function StoryInitialInput({
  disabled,
  error,
  onChange,
  value,
}: StoryInitialInputProps): JSX.Element {
  const errorId = "story-initial-text-error";

  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7">
      <label className="flex flex-col gap-3 text-sm font-semibold text-[var(--text-h)]">
        初始故事正文
        <textarea
          aria-describedby={error !== undefined ? errorId : undefined}
          aria-invalid={error !== undefined}
          className={textareaClassName}
          disabled={disabled}
          maxLength={20_000}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="输入故事开头或已有正文"
          value={value}
        />
      </label>
      {error !== undefined ? (
        <p
          className="mt-3 mb-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
          id={errorId}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
