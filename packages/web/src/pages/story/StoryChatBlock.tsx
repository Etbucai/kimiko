import type { JSX } from "react";
import { useId } from "react";
import type { StoryChatEntry } from "./storyChatTypes";

interface StoryChatBlockProps {
  readonly entry: StoryChatEntry;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onReasoningExpandedChange: (expanded: boolean) => void;
}

export function StoryChatBlock({
  entry,
  onExpandedChange,
  onReasoningExpandedChange,
}: StoryChatBlockProps): JSX.Element {
  const contentId = useId();
  const reasoningContentId = useId();

  return (
    <section
      aria-label="与 AI 聊聊"
      className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]"
    >
      <button
        aria-controls={contentId}
        aria-expanded={entry.isExpanded}
        className="flex w-full items-center justify-between gap-4 border-0 bg-transparent p-0 text-left"
        onClick={() => onExpandedChange(!entry.isExpanded)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block text-base font-bold text-(--text-h)">
            与 AI 聊聊
          </span>
          <span
            className="mt-1 block text-xs font-semibold text-(--text)"
            role="status"
          >
            {getStatusLabel(entry.status)}
          </span>
        </span>
        <span className="shrink-0 text-sm font-semibold text-(--accent)">
          {entry.isExpanded ? "收起" : "展开"}
        </span>
      </button>

      {entry.isExpanded ? (
        <div
          className="mt-4 flex flex-col gap-4 border-t border-(--border) pt-4"
          id={contentId}
          role="region"
        >
          <ChatTextSection label="你想聊的" text={entry.topic} />

          {entry.reasoningText.length > 0 ? (
            <section className="rounded-2xl border border-(--border) bg-(--input-bg) p-4">
              <button
                aria-controls={reasoningContentId}
                aria-expanded={entry.isReasoningExpanded}
                className="flex w-full items-center justify-between gap-4 border-0 bg-transparent p-0 text-left"
                onClick={() =>
                  onReasoningExpandedChange(!entry.isReasoningExpanded)
                }
                type="button"
              >
                <span className="text-sm font-bold text-(--text-h)">
                  AI 的思考
                </span>
                <span className="shrink-0 text-xs font-semibold text-(--accent)">
                  {entry.isReasoningExpanded ? "收起" : "展开"}
                </span>
              </button>
              {entry.isReasoningExpanded ? (
                <p
                  className="mt-3 mb-0 border-t border-(--border) pt-3 text-sm leading-7 whitespace-pre-wrap break-words text-(--text)"
                  id={reasoningContentId}
                  role="region"
                >
                  {entry.reasoningText}
                </p>
              ) : null}
            </section>
          ) : null}

          <ChatTextSection
            label="AI 的回答"
            muted={entry.answerText.length === 0}
            text={
              entry.answerText.length > 0
                ? entry.answerText
                : getEmptyAnswerLabel(entry.status)
            }
          />

          {entry.errorMessage !== undefined ? (
            <p
              className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm text-(--danger)"
              role="alert"
            >
              {entry.errorMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChatTextSection({
  label,
  muted = false,
  text,
}: {
  label: string;
  muted?: boolean;
  text: string;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-bold text-(--text-h)">{label}</h3>
      <p
        className={`m-0 text-base leading-8 whitespace-pre-wrap break-words ${
          muted ? "text-(--text)" : "text-(--text-h)"
        }`}
      >
        {text}
      </p>
    </section>
  );
}

function getStatusLabel(status: StoryChatEntry["status"]): string {
  switch (status) {
    case "connecting":
      return "正在连接";
    case "thinking":
      return "正在思考";
    case "answering":
      return "正在回答";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "failed":
      return "生成失败";
  }
}

function getEmptyAnswerLabel(status: StoryChatEntry["status"]): string {
  switch (status) {
    case "connecting":
    case "thinking":
    case "answering":
      return "正在等待回答...";
    case "cancelled":
      return "本次回答已取消";
    case "failed":
      return "本次回答生成失败";
    case "completed":
      return "";
  }
}
