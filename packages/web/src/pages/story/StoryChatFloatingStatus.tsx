import type { JSX } from "react";
import { CircleStop } from "lucide-react";

interface StoryChatFloatingStatusProps {
  readonly chapterNumber: number;
  readonly hasBottomBar: boolean;
  readonly onCancel: () => void;
}

export function StoryChatFloatingStatus({
  chapterNumber,
  hasBottomBar,
  onCancel,
}: StoryChatFloatingStatusProps): JSX.Element {
  const bottomClassName = hasBottomBar
    ? "bottom-[calc(5rem+env(safe-area-inset-bottom))]"
    : "bottom-[calc(1rem+env(safe-area-inset-bottom))]";

  return (
    <div
      className={`fixed right-4 ${bottomClassName} z-30 flex items-center gap-2`}
    >
      <p
        className="m-0 rounded-full border border-(--border) bg-(--panel-bg) px-4 py-2 text-xs font-bold text-(--text-h) shadow-(--shadow)"
        role="status"
      >
        第 {chapterNumber} 章 AI 回答中
      </p>
      <button
        aria-label="停止 AI 回答"
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-0 bg-(--danger) text-white shadow-(--shadow) transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
        onClick={onCancel}
        type="button"
      >
        <CircleStop aria-hidden size={24} strokeWidth={2.4} />
      </button>
    </div>
  );
}
