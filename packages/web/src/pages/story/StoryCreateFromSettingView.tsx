import type { JSX } from "react";
import type { StorySetting } from "@kimiko/schema";
import type { StorySettingDetailStatus } from "./StorySettingDetailView";
import { StorySettingTextBlock } from "./StorySettingTextBlock";

interface StoryCreateFromSettingViewProps {
  errorMessage: string;
  isGenerating: boolean;
  onBack: () => void;
  onOpeningChange: (value: string) => void;
  onRetry: () => void;
  onSubmit: () => void;
  opening: string;
  openingError?: string | undefined;
  setting: StorySetting | null;
  status: StorySettingDetailStatus;
}

const textareaClassName =
  "box-border min-h-[calc(10rem+2px)] w-full resize-y rounded-3xl border border-(--border) bg-(--input-bg) px-4 py-4 text-base leading-8 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 [field-sizing:content] placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

export function StoryCreateFromSettingView({
  errorMessage,
  isGenerating,
  onBack,
  onOpeningChange,
  onRetry,
  onSubmit,
  opening,
  openingError,
  setting,
  status,
}: StoryCreateFromSettingViewProps): JSX.Element {
  const errorId = "story-setting-opening-error";

  if (status === "loading") {
    return (
      <section
        className="rounded-3xl border border-(--border) bg-(--panel-bg) p-8 text-center shadow-[var(--shadow)]"
        role="status"
      >
        <p className="m-0 text-base text-(--text)">正在加载设定...</p>
      </section>
    );
  }

  if (status === "failed" || setting === null) {
    return (
      <section
        className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-[var(--shadow)]"
        role="alert"
      >
        <h2 className="m-0 text-xl font-bold text-(--text-h)">设定加载失败</h2>
        <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">
          {errorMessage}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            onClick={onBack}
            type="button"
          >
            返回故事列表
          </button>
          <button
            className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
            onClick={onRetry}
            type="button"
          >
            重试
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">
              从设定开始
            </p>
            <h2 className="mt-1 mb-0 text-xl font-bold text-(--text-h)">
              写下本次开场
            </h2>
          </div>
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            disabled={isGenerating}
            onClick={onBack}
            type="button"
          >
            返回故事列表
          </button>
        </div>
      </div>

      <StorySettingTextBlock content={setting.content} />

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="flex flex-col gap-4">
          <span className="text-sm font-semibold text-(--text)">开场</span>
          <textarea
            aria-describedby={openingError !== undefined ? errorId : undefined}
            aria-invalid={openingError !== undefined}
            className={textareaClassName}
            disabled={isGenerating}
            maxLength={8_000}
            onChange={(event) => onOpeningChange(event.currentTarget.value)}
            placeholder="写下你想从哪里开始，例如第一幕、主角处境或故事语气"
            rows={5}
            value={opening}
          />
        </label>
        {openingError !== undefined ? (
          <p
            className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm text-(--danger)"
            id={errorId}
            role="alert"
          >
            {openingError}
          </p>
        ) : null}
        <button
          className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isGenerating}
          type="submit"
        >
          {isGenerating ? "正在开场..." : "开场"}
        </button>
      </form>
    </section>
  );
}
