import type { JSX } from "react";

interface StorySettingTextBlockProps {
  content: string;
}

export function StorySettingTextBlock({
  content,
}: StorySettingTextBlockProps): JSX.Element {
  return (
    <div className="whitespace-pre-wrap rounded-3xl border border-(--border) bg-(--panel-bg) px-4 py-4 text-base leading-8 text-(--text-h) shadow-[var(--shadow)]">
      {content}
    </div>
  );
}
