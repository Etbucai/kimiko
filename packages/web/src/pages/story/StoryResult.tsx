import type { JSX } from "react";
import type { ContinueStoryUsage } from "@kimiko/schema";

export interface StoryStreamingResult {
  continuedStory: string;
  model?: string;
  elapsedMs?: number;
  usage?: ContinueStoryUsage;
}

interface StoryResultProps {
  result: StoryStreamingResult;
  status: "streaming" | "completed" | "cancelled" | "failed";
  statusMessage?: string | undefined;
}

export function StoryResult({
  result,
  status,
  statusMessage,
}: StoryResultProps): JSX.Element {
  const metadata = getCompletedMetadata(status, result);

  return (
    <article
      aria-label="续写结果"
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7"
    >
      {result.continuedStory.length > 0 ? (
        <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
          {result.continuedStory}
        </p>
      ) : null}

      {metadata !== null ? (
        <p className="mt-5 mb-0 border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--text)]">
          模型：{metadata.model} / 耗时：{metadata.elapsedMs}ms / Token：
          {metadata.usage.totalTokens}
        </p>
      ) : null}

      {statusMessage !== undefined ? (
        <p
          className="mt-5 mb-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
          role={status === "failed" ? "alert" : "status"}
        >
          {statusMessage}
        </p>
      ) : null}
    </article>
  );
}

function getCompletedMetadata(
  status: StoryResultProps["status"],
  result: StoryStreamingResult,
):
  | Readonly<{
      model: string;
      elapsedMs: number;
      usage: ContinueStoryUsage;
    }>
  | null {
  if (
    status !== "completed" ||
    result.model === undefined ||
    result.elapsedMs === undefined ||
    result.usage === undefined
  ) {
    return null;
  }

  return {
    model: result.model,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
  };
}
