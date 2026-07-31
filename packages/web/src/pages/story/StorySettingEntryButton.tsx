import type { JSX } from "react";

interface StorySettingEntryButtonProps {
  onClick: () => void;
}

export function StorySettingEntryButton({
  onClick,
}: StorySettingEntryButtonProps): JSX.Element {
  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="m-0 text-xs font-semibold text-(--accent)">
            先写设定，再开故事
          </p>
          <h2 className="mt-1 mb-0 text-lg font-bold text-(--text-h)">
            从设定开始
          </h2>
          <p className="mt-2 mb-0 text-sm leading-6 text-(--text)">
            复用已有世界观，或先让系统帮你补全一份设定。
          </p>
        </div>
        <button
          className="min-h-11 rounded-2xl border border-(--accent-border) bg-(--accent-bg) px-5 py-3 font-bold text-(--accent) transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
          onClick={onClick}
          type="button"
        >
          从设定开始
        </button>
      </div>
    </section>
  );
}
