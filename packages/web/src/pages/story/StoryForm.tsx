import type { JSX } from "react";

export type StoryFieldName = "storyText" | "instruction";

export interface StoryFormState {
  storyText: string;
  instruction: string;
}

export interface StoryFieldErrors {
  storyText?: string;
  instruction?: string;
}

interface StoryFormProps {
  disabled: boolean;
  fieldErrors: StoryFieldErrors;
  onChange: (field: StoryFieldName, value: string) => void;
  onSubmit: () => Promise<void>;
  value: StoryFormState;
}

const textareaClassName =
  "box-border min-h-40 w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--input-bg)] px-4 py-3 text-base leading-7 text-[var(--text-h)] outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-[var(--text)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

const labelClassName =
  "flex flex-col gap-2 text-sm font-semibold text-[var(--text-h)]";

const errorClassName =
  "rounded-xl bg-[var(--danger-bg)] px-3 py-2 text-sm font-normal text-[var(--danger)]";

export function StoryForm({
  disabled,
  fieldErrors,
  onChange,
  onSubmit,
  value,
}: StoryFormProps): JSX.Element {
  const storyTextErrorId = "story-text-error";
  const instructionErrorId = "story-instruction-error";

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <label className={labelClassName}>
        故事正文
        <textarea
          aria-describedby={
            fieldErrors.storyText !== undefined ? storyTextErrorId : undefined
          }
          aria-invalid={fieldErrors.storyText !== undefined}
          className={textareaClassName}
          disabled={disabled}
          maxLength={20_000}
          name="storyText"
          onChange={(event) =>
            onChange("storyText", event.currentTarget.value)
          }
          placeholder="输入已有故事正文"
          value={value.storyText}
        />
      </label>
      {fieldErrors.storyText !== undefined ? (
        <p className={errorClassName} id={storyTextErrorId} role="alert">
          {fieldErrors.storyText}
        </p>
      ) : null}

      <label className={labelClassName}>
        续写指令
        <textarea
          aria-describedby={
            fieldErrors.instruction !== undefined
              ? instructionErrorId
              : undefined
          }
          aria-invalid={fieldErrors.instruction !== undefined}
          className={textareaClassName}
          disabled={disabled}
          maxLength={8_000}
          name="instruction"
          onChange={(event) =>
            onChange("instruction", event.currentTarget.value)
          }
          placeholder="描述接下来要发生的主要情节和人物行动"
          value={value.instruction}
        />
      </label>
      {fieldErrors.instruction !== undefined ? (
        <p className={errorClassName} id={instructionErrorId} role="alert">
          {fieldErrors.instruction}
        </p>
      ) : null}

      <button
        className="min-h-12 rounded-2xl border-0 bg-[var(--accent)] px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:cursor-pointer enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={disabled}
        type="submit"
      >
        {disabled ? "生成中..." : "生成续写"}
      </button>
    </form>
  );
}
