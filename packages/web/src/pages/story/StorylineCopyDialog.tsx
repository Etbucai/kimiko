import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export interface StorylineCopyDialogSubmitValue {
  readonly title: string;
  readonly throughChapter: number;
}

interface StorylineCopyDialogProps {
  readonly chapterCount: number;
  readonly defaultThroughChapter: number;
  readonly error?: string | undefined;
  readonly isSubmitting: boolean;
  readonly onClose: () => void;
  readonly onInputChange: () => void;
  readonly onSubmit: (value: StorylineCopyDialogSubmitValue) => void;
  readonly sourceTitle: string;
}

interface CopyFieldErrors {
  readonly title?: string;
  readonly throughChapter?: string;
}

const storylineTitleMaxLength = 80;
const copyTitleSuffix = "（副本）";

export function StorylineCopyDialog({
  chapterCount,
  defaultThroughChapter,
  error,
  isSubmitting,
  onClose,
  onInputChange,
  onSubmit,
  sourceTitle,
}: StorylineCopyDialogProps): JSX.Element {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(() => buildDefaultCopyTitle(sourceTitle));
  const [throughChapterInput, setThroughChapterInput] = useState(() =>
    String(clampChapter(defaultThroughChapter, chapterCount)),
  );
  const [fieldErrors, setFieldErrors] = useState<CopyFieldErrors>({});
  const titleErrorId = "storyline-copy-title-error";
  const chapterErrorId = "storyline-copy-chapter-error";
  const requestErrorId = "storyline-copy-request-error";

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });

    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose]);

  function handleSubmit(): void {
    const validation = validateCopyForm({
      chapterCount,
      throughChapterInput,
      title,
    });
    if (!validation.success) {
      setFieldErrors(validation.fieldErrors);
      return;
    }

    setFieldErrors({});
    onSubmit(validation.value);
  }

  return (
    <>
      <button
        aria-label="关闭复制故事弹窗"
        className="fixed inset-0 z-40 cursor-default border-0 bg-black/25"
        disabled={isSubmitting}
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby="storyline-copy-dialog-title"
        aria-modal="true"
        className="fixed top-1/2 left-1/2 z-50 box-border flex max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6"
        role="dialog"
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                className="m-0 text-xl font-bold text-(--text-h)"
                id="storyline-copy-dialog-title"
              >
                复制故事
              </h2>
              <p className="mt-1.5 mb-0 text-sm leading-6 text-(--text)">
                创建一个完全独立的新故事，原故事不会被修改。
              </p>
            </div>
            <button
              aria-label="关闭复制故事弹窗"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-(--border) bg-transparent text-(--text-h) transition-[border-color,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:border-(--accent-border) disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSubmitting}
              onClick={onClose}
              type="button"
            >
              <X aria-hidden size={20} strokeWidth={2.3} />
            </button>
          </div>

          <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
            新故事标题
            <input
              aria-describedby={
                fieldErrors.title !== undefined ? titleErrorId : undefined
              }
              aria-invalid={fieldErrors.title !== undefined}
              className="box-border min-h-12 w-full rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-base text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              maxLength={storylineTitleMaxLength}
              onChange={(event) => {
                setTitle(event.currentTarget.value);
                setFieldErrors((current) =>
                  removeCopyFieldError(current, "title"),
                );
                onInputChange();
              }}
              ref={titleInputRef}
              value={title}
            />
            {fieldErrors.title !== undefined ? (
              <span
                className="text-sm font-normal text-(--danger)"
                id={titleErrorId}
              >
                {fieldErrors.title}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
            截止章节
            <input
              aria-describedby={
                fieldErrors.throughChapter !== undefined
                  ? chapterErrorId
                  : undefined
              }
              aria-invalid={fieldErrors.throughChapter !== undefined}
              className="box-border min-h-12 w-full rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-base text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              inputMode="numeric"
              max={chapterCount}
              min={1}
              onChange={(event) => {
                setThroughChapterInput(event.currentTarget.value);
                setFieldErrors((current) =>
                  removeCopyFieldError(current, "throughChapter"),
                );
                onInputChange();
              }}
              step={1}
              type="number"
              value={throughChapterInput}
            />
            <span className="text-xs font-normal text-(--text)">
              共 {chapterCount} 章，复制第 1 章到所选章节。
            </span>
            {fieldErrors.throughChapter !== undefined ? (
              <span
                className="text-sm font-normal text-(--danger)"
                id={chapterErrorId}
              >
                {fieldErrors.throughChapter}
              </span>
            ) : null}
          </label>

          {error !== undefined ? (
            <p
              className="m-0 rounded-2xl bg-(--danger-bg) px-4 py-3 text-sm leading-6 text-(--danger)"
              id={requestErrorId}
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              className="min-h-12 rounded-2xl border border-(--border) bg-transparent px-5 py-3 font-bold text-(--text-h) transition-[border-color,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:border-(--accent-border) disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSubmitting}
              onClick={onClose}
              type="button"
            >
              取消
            </button>
            <button
              aria-describedby={
                error !== undefined ? requestErrorId : undefined
              }
              className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-wait disabled:opacity-60"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "正在创建..." : "创建副本"}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

type CopyFormValidation =
  | Readonly<{
      success: true;
      value: StorylineCopyDialogSubmitValue;
    }>
  | Readonly<{
      success: false;
      fieldErrors: CopyFieldErrors;
    }>;

function validateCopyForm(input: {
  readonly chapterCount: number;
  readonly throughChapterInput: string;
  readonly title: string;
}): CopyFormValidation {
  const fieldErrors: {
    title?: string;
    throughChapter?: string;
  } = {};
  const title = input.title.trim();
  if (title.length === 0) {
    fieldErrors.title = "请输入新故事标题";
  } else if (title.length > storylineTitleMaxLength) {
    fieldErrors.title = `标题不能超过 ${storylineTitleMaxLength} 个字符`;
  }

  const normalizedChapter = input.throughChapterInput.trim();
  const throughChapter = Number(normalizedChapter);
  if (
    !/^\d+$/.test(normalizedChapter) ||
    !Number.isSafeInteger(throughChapter) ||
    throughChapter < 1 ||
    throughChapter > input.chapterCount
  ) {
    fieldErrors.throughChapter = `请输入 1 到 ${input.chapterCount} 之间的整数章节`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    value: {
      title,
      throughChapter,
    },
  };
}

function buildDefaultCopyTitle(sourceTitle: string): string {
  const availableSourceLength =
    storylineTitleMaxLength - copyTitleSuffix.length;
  const normalizedSourceTitle = sourceTitle.trim();
  return `${normalizedSourceTitle.slice(
    0,
    availableSourceLength,
  )}${copyTitleSuffix}`;
}

function clampChapter(value: number, chapterCount: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), chapterCount);
}

function removeCopyFieldError(
  errors: CopyFieldErrors,
  field: keyof CopyFieldErrors,
): CopyFieldErrors {
  if (errors[field] === undefined) {
    return errors;
  }

  const nextErrors = { ...errors };
  delete nextErrors[field];
  return nextErrors;
}
