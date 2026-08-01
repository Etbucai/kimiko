import type { JSX } from "react";
import { useId } from "react";

interface ReasoningPanelProps {
  isExpanded: boolean;
  isThinking: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  text: string;
}

export function ReasoningPanel({
  isExpanded,
  isThinking,
  onExpandedChange,
  text,
}: ReasoningPanelProps): JSX.Element | null {
  const contentId = useId();

  if (text.length === 0) {
    return null;
  }

  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
      <button
        aria-controls={contentId}
        aria-expanded={isExpanded}
        className="flex w-full items-center justify-between gap-4 border-0 bg-transparent p-0 text-left"
        onClick={() => onExpandedChange(!isExpanded)}
        type="button"
      >
        <span className="text-base font-bold text-(--text-h)">
          {isThinking ? "正在思考" : "思考过程"}
        </span>
        <span className="shrink-0 text-sm font-semibold text-(--accent)">
          {isExpanded ? "收起" : "展开"}
        </span>
      </button>
      {isExpanded ? (
        <div
          className="mt-4 border-t border-(--border) pt-4 text-sm leading-7 whitespace-pre-wrap break-words text-(--text)"
          id={contentId}
          role="region"
        >
          {text}
        </div>
      ) : null}
    </section>
  );
}
