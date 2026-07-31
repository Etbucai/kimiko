import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

export type StorySettingCompletionStatus =
  "completed" | "idle" | "saving" | "streaming";

interface StorySettingCreateViewProps {
  completionText: string;
  error?: string | undefined;
  inspiration: string;
  isReasoningExpanded: boolean;
  onBack: () => void;
  onComplete: () => void;
  onInspirationChange: (value: string) => void;
  onReasoningExpandedChange: (isExpanded: boolean) => void;
  onRevise: (revisionInstruction: string) => void;
  onSave: () => void;
  reasoningText: string;
  status: StorySettingCompletionStatus;
}

const textareaClassName =
  "box-border min-h-[calc(10rem+2px)] w-full resize-y rounded-3xl border border-(--border) bg-(--input-bg) px-4 py-4 text-base leading-8 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 [field-sizing:content] placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70";

export function StorySettingCreateView({
  completionText,
  error,
  inspiration,
  isReasoningExpanded,
  onBack,
  onComplete,
  onInspirationChange,
  onReasoningExpandedChange,
  onRevise,
  onSave,
  reasoningText,
  status,
}: StorySettingCreateViewProps): JSX.Element {
  const [isRevisionDialogOpen, setIsRevisionDialogOpen] = useState(false);
  const errorId = "story-setting-inspiration-error";
  const reasoningContentId = "story-setting-reasoning-content";
  const isInputDisabled =
    status === "streaming" || status === "completed" || status === "saving";
  const isCompleting = status === "streaming";
  const isSaving = status === "saving";
  const canSave = status === "completed" && completionText.trim().length > 0;

  return (
    <section className="flex flex-col gap-5">
      <div className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">新设定</p>
            <h2 className="mt-1 mb-0 text-xl font-bold text-(--text-h)">
              让系统补全设定
            </h2>
          </div>
          <button
            className="min-h-11 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            disabled={isCompleting || isSaving}
            onClick={onBack}
            type="button"
          >
            返回
          </button>
        </div>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onComplete();
        }}
      >
        <label className="flex flex-col gap-4">
          <span className="text-sm font-semibold text-(--text)">灵感</span>
          <textarea
            aria-describedby={error !== undefined ? errorId : undefined}
            aria-invalid={error !== undefined}
            className={textareaClassName}
            disabled={isInputDisabled}
            maxLength={8_000}
            onChange={(event) => onInspirationChange(event.currentTarget.value)}
            placeholder="写下你的世界观、角色关系、题材氛围，或者任何零散灵感"
            rows={5}
            value={inspiration}
          />
        </label>
        {error !== undefined ? (
          <p
            className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm text-(--danger)"
            id={errorId}
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <button
          className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isInputDisabled}
          type="submit"
        >
          {isCompleting ? "正在补全..." : "补全设定"}
        </button>
      </form>

      {reasoningText.length > 0 ? (
        <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]">
          <button
            aria-controls={reasoningContentId}
            aria-expanded={isReasoningExpanded}
            className="flex w-full items-center justify-between gap-4 border-0 bg-transparent p-0 text-left"
            onClick={() => onReasoningExpandedChange(!isReasoningExpanded)}
            type="button"
          >
            <span className="text-base font-bold text-(--text-h)">
              {isCompleting && completionText.length === 0
                ? "正在思考"
                : "思考过程"}
            </span>
            <span className="shrink-0 text-sm font-semibold text-(--accent)">
              {isReasoningExpanded ? "收起" : "展开"}
            </span>
          </button>
          {isReasoningExpanded ? (
            <div
              className="mt-4 border-t border-(--border) pt-4 text-sm leading-7 whitespace-pre-wrap break-words text-(--text)"
              id={reasoningContentId}
              role="region"
            >
              {reasoningText}
            </div>
          ) : null}
        </section>
      ) : null}

      {completionText.length > 0 ? (
        <section
          className="flex flex-col gap-4 rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)]"
          role={isCompleting ? "status" : undefined}
        >
          <h3 className="m-0 text-base font-bold text-(--text-h)">补全结果</h3>
          <div className="whitespace-pre-wrap text-base leading-8 text-(--text-h)">
            {completionText}
          </div>
          {canSave || isSaving ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                className="min-h-12 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:border-(--accent-border) disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isSaving}
                onClick={() => setIsRevisionDialogOpen(true)}
                type="button"
              >
                修改
              </button>
              <button
                className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
                disabled={isSaving}
                onClick={onSave}
                type="button"
              >
                {isSaving ? "正在保存..." : "保存设定"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {isRevisionDialogOpen ? (
        <StorySettingRevisionDialog
          onCancel={() => setIsRevisionDialogOpen(false)}
          onSubmit={(revisionInstruction) => {
            setIsRevisionDialogOpen(false);
            onRevise(revisionInstruction);
          }}
        />
      ) : null}
    </section>
  );
}

interface StorySettingRevisionDialogProps {
  onCancel: () => void;
  onSubmit: (revisionInstruction: string) => void;
}

function StorySettingRevisionDialog({
  onCancel,
  onSubmit,
}: StorySettingRevisionDialogProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [error, setError] = useState<string | undefined>();
  const errorId = "story-setting-revision-error";
  const titleId = "story-setting-revision-title";

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <>
      <button
        aria-label="取消修改设定"
        className="fixed inset-0 z-40 cursor-default border-0 bg-black/30"
        onClick={onCancel}
        type="button"
      />
      <section
        aria-describedby={error !== undefined ? errorId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="fixed inset-x-4 top-1/2 z-50 max-h-[calc(100svh-2rem)] -translate-y-1/2 overflow-y-auto rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-[var(--shadow)] backdrop-blur md:inset-x-auto md:left-1/2 md:w-full md:max-w-xl md:-translate-x-1/2"
        role="dialog"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const normalizedInstruction = revisionInstruction.trim();
            if (normalizedInstruction.length === 0) {
              setError("请输入修改意见");
              return;
            }

            onSubmit(normalizedInstruction);
          }}
        >
          <div>
            <p className="m-0 text-xs font-semibold text-(--accent)">
              修改设定
            </p>
            <h2
              className="mt-1 mb-0 text-xl font-bold text-(--text-h)"
              id={titleId}
            >
              提出修改意见
            </h2>
          </div>

          <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
            修改意见
            <textarea
              aria-describedby={error !== undefined ? errorId : undefined}
              aria-invalid={error !== undefined}
              className="box-border max-h-[50svh] min-h-32 w-full resize-y rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-base leading-7 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 [field-sizing:content] placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)]"
              maxLength={8_000}
              onChange={(event) => {
                setRevisionInstruction(event.currentTarget.value);
                setError(undefined);
              }}
              placeholder="例如：弱化科幻元素，增加两位主角之间的利益冲突"
              ref={textareaRef}
              rows={4}
              value={revisionInstruction}
            />
          </label>

          {error !== undefined ? (
            <p
              className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm text-(--danger)"
              id={errorId}
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              className="min-h-12 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
            <button
              className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
              type="submit"
            >
              提交修改
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
