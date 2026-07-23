import type { JSX } from "react";
import type {
  StorylineSegment,
  StorylineSegmentId,
  StorylineSnapshot,
} from "@kimiko/schema";

export interface RewriteDraftState {
  readonly targetSegmentId: StorylineSegmentId;
  readonly text: string;
}

interface StorylineReaderProps {
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
  canRewrite: boolean;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
}

export function StorylineReader({
  storyline,
  temporaryAppendText,
  temporaryRewrite,
  temporaryTextStatus,
  canRewrite,
  onStartRewrite,
}: StorylineReaderProps): JSX.Element {
  const hasGeneratedSegment = storyline.segments.some(
    (segment) => segment.type === "generated",
  );
  const latestGeneratedSegmentId = getLatestGeneratedSegmentId(
    storyline.segments,
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
            canRewrite={
              canRewrite &&
              segment.type === "generated" &&
              segment.id === latestGeneratedSegmentId
            }
            onStartRewrite={onStartRewrite}
            segment={segment}
            showDivider={shouldShowGeneratedDivider(
              storyline.segments,
              index,
            )}
            temporaryRewrite={temporaryRewrite}
            temporaryTextStatus={temporaryTextStatus}
          />
        ))}

        {temporaryAppendText.length > 0 ? (
          <section aria-label="正在生成的续写" className="flex flex-col gap-4">
            {hasGeneratedSegment ? <SegmentDivider label="生成中" /> : null}
            <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
              {temporaryAppendText}
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

function getLatestGeneratedSegmentId(
  segments: readonly StorylineSegment[],
): StorylineSegmentId | null {
  const latestGeneratedSegment = [...segments]
    .reverse()
    .find((segment) => segment.type === "generated");

  return latestGeneratedSegment?.id ?? null;
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
  canRewrite: boolean;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
  segment: StorylineSegment;
  showDivider: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
}

function StorylineSegmentBlock({
  canRewrite,
  onStartRewrite,
  segment,
  showDivider,
  temporaryRewrite,
  temporaryTextStatus,
}: StorylineSegmentBlockProps): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      {showDivider ? <SegmentDivider label="续写" /> : null}
      <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
        {segment.text}
      </p>
      {canRewrite ? (
        <div className="flex justify-end">
          <button
            className="rounded-full border border-[var(--border)] bg-transparent px-3 py-1 text-xs font-semibold text-[var(--text-h)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-[var(--accent-border)]"
            onClick={() => onStartRewrite(segment.id)}
            type="button"
          >
            重写
          </button>
        </div>
      ) : null}
      {temporaryRewrite?.targetSegmentId === segment.id &&
      temporaryRewrite.text.length > 0 ? (
        <section aria-label="正在重写的正文" className="flex flex-col gap-4">
          <SegmentDivider label="重写中" />
          <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
            {temporaryRewrite.text}
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
