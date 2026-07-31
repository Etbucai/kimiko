import type { JSX } from "react";
import type { StorySettingId, StorySettingListItem } from "@kimiko/schema";

export type StorySettingListStatus = "empty" | "failed" | "loading" | "ready";

interface StorySettingListViewProps {
  errorMessage: string;
  onBack: () => void;
  onCreate: () => void;
  onRetry: () => void;
  onSelect: (settingId: StorySettingId) => void;
  settings: readonly StorySettingListItem[];
  status: StorySettingListStatus;
}

export function StorySettingListView({
  errorMessage,
  onBack,
  onCreate,
  onRetry,
  onSelect,
  settings,
  status,
}: StorySettingListViewProps): JSX.Element {
  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">
              故事设定
            </p>
            <h2 className="mt-1 mb-0 text-xl font-bold text-(--text-h)">
              选择一份设定
            </h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
              onClick={onBack}
              type="button"
            >
              返回
            </button>
            <button
              className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
              onClick={onCreate}
              type="button"
            >
              新设定
            </button>
          </div>
        </div>
      </div>

      {status === "loading" ? (
        <StorySettingListLoading />
      ) : status === "failed" ? (
        <StorySettingListError message={errorMessage} onRetry={onRetry} />
      ) : status === "empty" ? (
        <StorySettingListEmpty onCreate={onCreate} />
      ) : (
        <div className="flex flex-col gap-3">
          {settings.map((setting) => (
            <button
              className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 text-left text-(--text) shadow-[var(--shadow)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
              key={setting.id}
              onClick={() => onSelect(setting.id)}
              type="button"
            >
              <article className="flex flex-col gap-3">
                <p className="m-0 line-clamp-4 text-sm leading-6 text-(--text-h)">
                  {setting.preview}
                </p>
                <time
                  className="text-xs font-semibold text-(--accent)"
                  dateTime={setting.createdAt}
                >
                  {formatCreatedAt(setting.createdAt)}
                </time>
              </article>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function StorySettingListLoading(): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-8 text-center shadow-[var(--shadow)]"
      role="status"
    >
      <p className="m-0 text-base text-(--text)">正在加载设定列表...</p>
    </section>
  );
}

interface StorySettingListErrorProps {
  message: string;
  onRetry: () => void;
}

function StorySettingListError({
  message,
  onRetry,
}: StorySettingListErrorProps): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-[var(--shadow)]"
      role="alert"
    >
      <h3 className="m-0 text-lg font-bold text-(--text-h)">
        设定列表加载失败
      </h3>
      <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">{message}</p>
      <button
        className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        onClick={onRetry}
        type="button"
      >
        重试
      </button>
    </section>
  );
}

interface StorySettingListEmptyProps {
  onCreate: () => void;
}

function StorySettingListEmpty({
  onCreate,
}: StorySettingListEmptyProps): JSX.Element {
  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-[var(--shadow)]">
      <h3 className="m-0 text-lg font-bold text-(--text-h)">还没有设定</h3>
      <p className="mt-3 mb-6 text-sm leading-6 text-(--text)">
        先创建一份设定，再从它开始新故事。
      </p>
      <button
        className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        onClick={onCreate}
        type="button"
      >
        新设定
      </button>
    </section>
  );
}

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
