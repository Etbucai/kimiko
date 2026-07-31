import type { JSX } from "react";
import type { StorySetting } from "@kimiko/schema";
import { StorySettingTextBlock } from "./StorySettingTextBlock";

export type StorySettingDetailStatus = "failed" | "loading" | "ready";

interface StorySettingDetailViewProps {
  errorMessage: string;
  onBack: () => void;
  onRetry: () => void;
  onStart: () => void;
  setting: StorySetting | null;
  status: StorySettingDetailStatus;
}

export function StorySettingDetailView({
  errorMessage,
  onBack,
  onRetry,
  onStart,
  setting,
  status,
}: StorySettingDetailViewProps): JSX.Element {
  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">
              设定详情
            </p>
            <h2 className="mt-1 mb-0 text-xl font-bold text-(--text-h)">
              查看设定
            </h2>
          </div>
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            onClick={onBack}
            type="button"
          >
            返回
          </button>
        </div>
      </div>

      {status === "loading" ? (
        <StorySettingDetailLoading />
      ) : status === "failed" ? (
        <StorySettingDetailError
          message={errorMessage}
          onBack={onBack}
          onRetry={onRetry}
        />
      ) : setting === null ? (
        <StorySettingDetailError
          message={errorMessage}
          onBack={onBack}
          onRetry={onRetry}
        />
      ) : (
        <>
          <StorySettingTextBlock content={setting.content} />
          <button
            className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
            onClick={onStart}
            type="button"
          >
            从设定开始
          </button>
        </>
      )}
    </section>
  );
}

function StorySettingDetailLoading(): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-8 text-center shadow-[var(--shadow)]"
      role="status"
    >
      <p className="m-0 text-base text-(--text)">正在加载设定...</p>
    </section>
  );
}

interface StorySettingDetailErrorProps {
  message: string;
  onBack: () => void;
  onRetry: () => void;
}

function StorySettingDetailError({
  message,
  onBack,
  onRetry,
}: StorySettingDetailErrorProps): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-[var(--shadow)]"
      role="alert"
    >
      <h3 className="m-0 text-lg font-bold text-(--text-h)">设定加载失败</h3>
      <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">{message}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
          onClick={onBack}
          type="button"
        >
          返回列表
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
