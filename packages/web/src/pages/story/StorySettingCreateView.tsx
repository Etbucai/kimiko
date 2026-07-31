import type { JSX } from "react";

export type StorySettingCompletionStatus =
  | "completed"
  | "idle"
  | "saving"
  | "streaming";

interface StorySettingCreateViewProps {
  completionText: string;
  error?: string | undefined;
  inspiration: string;
  onBack: () => void;
  onComplete: () => void;
  onInspirationChange: (value: string) => void;
  onSave: () => void;
  status: StorySettingCompletionStatus;
}

const textareaClassName =
  "box-border min-h-[calc(10rem+2px)] w-full resize-y rounded-3xl border border-(--border) bg-(--input-bg) px-4 py-4 text-base leading-8 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 [field-sizing:content] placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

export function StorySettingCreateView({
  completionText,
  error,
  inspiration,
  onBack,
  onComplete,
  onInspirationChange,
  onSave,
  status,
}: StorySettingCreateViewProps): JSX.Element {
  const errorId = "story-setting-inspiration-error";
  const isInputDisabled = status === "streaming" || status === "completed" || status === "saving";
  const isCompleting = status === "streaming";
  const isSaving = status === "saving";
  const canSave =
    status === "completed" && completionText.trim().length > 0;

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">
              新设定
            </p>
            <h2 className="mt-1 mb-0 text-xl font-bold text-(--text-h)">
              让系统补全设定
            </h2>
          </div>
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            disabled={isCompleting || isSaving}
            onClick={onBack}
            type="button"
          >
            返回
          </button>
        </div>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onComplete();
        }}
      >
        <label className="flex flex-col gap-4">
          <span className="text-sm font-semibold text-(--text)">灵感</span>
          <textarea
            aria-describedby={error !== undefined ? errorId : undefined}
            aria-invalid={error !== undefined}
            className={textareaClassName}
            disabled={isInputDisabled}
            maxLength={8_000}
            onChange={(event) => onInspirationChange(event.currentTarget.value)}
            placeholder="写下你的世界观、角色关系、题材氛围，或者任何零散灵感"
            rows={5}
            value={inspiration}
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
          className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isCompleting || isSaving}
          type="submit"
        >
          {isCompleting ? "正在补全..." : "补全设定"}
        </button>
      </form>

      {completionText.length > 0 ? (
        <section
          className="flex flex-col gap-4 rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]"
          role={isCompleting ? "status" : undefined}
        >
          <h3 className="m-0 text-base font-bold text-(--text-h)">
            补全结果
          </h3>
          <div className="whitespace-pre-wrap text-base leading-8 text-(--text-h)">
            {completionText}
          </div>
          {canSave || isSaving ? (
            <button
              className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isSaving}
              onClick={onSave}
              type="button"
            >
              {isSaving ? "正在保存..." : "保存设定"}
            </button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
