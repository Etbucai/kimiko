import type { JSX } from "react";
import type { StorylineSegment, StorylineSnapshot } from "@kimiko/schema";

interface StorylineReaderProps {
  storyline: StorylineSnapshot;
  temporaryGeneratedText: string;
  temporaryTextStatus: "streaming" | "summarizing" | null;
}

export function StorylineReader({
  storyline,
  temporaryGeneratedText,
  temporaryTextStatus,
}: StorylineReaderProps): JSX.Element {
  const hasGeneratedSegment = storyline.segments.some(
    (segment) => segment.type === "generated",
  );

  return (
    <article
      aria-label="故事正文"
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7"
    >
      <div className="flex flex-col gap-6">
        {storyline.segments.map((segment, index) => (
          <StorylineSegmentBlock
            key={segment.id}
            segment={segment}
            showDivider={shouldShowGeneratedDivider(
              storyline.segments,
              index,
            )}
          />
        ))}

        {temporaryGeneratedText.length > 0 ? (
          <section aria-label="正在生成的续写" className="flex flex-col gap-4">
            {hasGeneratedSegment ? <SegmentDivider label="生成中" /> : null}
            <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
              {temporaryGeneratedText}
            </p>
            {temporaryTextStatus !== null ? (
              <p className="m-0 text-xs text-[var(--text)]" role="status">
                {temporaryTextStatus === "streaming"
                  ? "正在生成..."
                  : "正在记录角色摘要..."}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </article>
  );
}

function shouldShowGeneratedDivider(
  segments: readonly StorylineSegment[],
  index: number,
): boolean {
  const currentSegment = segments[index];
  if (currentSegment?.type !== "generated") {
    return false;
  }

  return segments
    .slice(0, index)
    .some((segment) => segment.type === "generated");
}

interface StorylineSegmentBlockProps {
  segment: StorylineSegment;
  showDivider: boolean;
}

function StorylineSegmentBlock({
  segment,
  showDivider,
}: StorylineSegmentBlockProps): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      {showDivider ? <SegmentDivider label="续写" /> : null}
      <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
        {segment.text}
      </p>
    </section>
  );
}

interface SegmentDividerProps {
  label: string;
}

function SegmentDivider({ label }: SegmentDividerProps): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--text)]">
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}
