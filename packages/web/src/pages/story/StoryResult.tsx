import type { JSX } from "react";
import type { ContinueStoryResponse } from "@kimiko/schema";

interface StoryResultProps {
  result: ContinueStoryResponse;
}

export function StoryResult({ result }: StoryResultProps): JSX.Element {
  return (
    <article
      aria-label="续写结果"
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7"
    >
      <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
        {result.continuedStory}
      </p>
      <p className="mt-5 mb-0 border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--text)]">
        模型：{result.model} / 耗时：{result.elapsedMs}ms / Token：
        {result.usage.totalTokens}
      </p>
    </article>
  );
}
