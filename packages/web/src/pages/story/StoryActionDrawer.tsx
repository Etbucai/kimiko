import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { StoryActionKind } from "./StoryActionFab";
import type {
  AppendTargetLength,
  AppendTargetLengthOption,
} from "./append-target-length-preference";

interface StoryActionDrawerAppendLengthSelector {
  readonly value: AppendTargetLength;
  readonly options: readonly AppendTargetLengthOption[];
  readonly onChange: (value: AppendTargetLength) => void;
}

interface StoryActionDrawerProps {
  appendLengthSelector?: StoryActionDrawerAppendLengthSelector | undefined;
  error?: string | undefined;
  mode: StoryActionKind;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  value: string;
}

const actionCopy: Record<
  StoryActionKind,
  Readonly<{
    label: string;
    maxLength: number;
    placeholder: string;
    submitText: string;
    title: string;
  }>
> = {
  append: {
    title: "续写故事",
    label: "续写指令",
    placeholder: "描述接下来要发生的主要情节和人物行动",
    submitText: "生成续写",
    maxLength: 8_000,
  },
  rewrite: {
    title: "重写上一段",
    label: "重写指令",
    placeholder: "例如：不要转变场景，文风更加轻快，增加对气味的描写",
    submitText: "生成重写",
    maxLength: 8_000,
  },
  dialogue: {
    title: "互动对话",
    label: "互动输入",
    placeholder:
      "写一句角色台词或动作，例如：大凡朝厨房喊了一声，让馥冰帮他拿奶茶",
    submitText: "生成互动",
    maxLength: 1_000,
  },
};

export function StoryActionDrawer({
  appendLengthSelector,
  error,
  mode,
  onChange,
  onClose,
  onSubmit,
  value,
}: StoryActionDrawerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const errorId = "story-action-drawer-error";
  const copy = actionCopy[mode];

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => cancelAnimationFrame(frameId);
  }, [mode]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      <button
        aria-label="关闭输入抽屉"
        className="fixed inset-0 z-30 cursor-default border-0 bg-black/20"
        onClick={onClose}
        type="button"
      />
      <section
        aria-label={copy.title}
        className="fixed inset-x-0 bottom-0 z-40 rounded-t-3xl border border-(--border) bg-(--panel-bg) px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-10px_24px_rgba(0,0,0,0.12)] backdrop-blur md:px-6"
      >
        <form
          className="mx-auto flex w-full max-w-3xl flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-base font-bold text-(--text-h)">
              {copy.title}
            </h2>
            <button
              aria-label="关闭输入抽屉"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-(--border) bg-transparent text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden size={20} strokeWidth={2.3} />
            </button>
          </div>

          {mode === "append" && appendLengthSelector !== undefined ? (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="px-0 text-sm font-semibold text-(--text-h)">
                续写长度
              </legend>
              <div className="grid grid-cols-4 gap-2">
                {appendLengthSelector.options.map((option) => {
                  const isSelected =
                    option.value === appendLengthSelector.value;

                  return (
                    <button
                      aria-pressed={isSelected}
                      className={`min-h-11 rounded-2xl border px-3 py-2 text-sm font-bold transition-[background-color,border-color,box-shadow,transform] duration-200 focus-visible:shadow-[0_0_0_3px_var(--accent-bg)] focus-visible:outline-none ${
                        isSelected
                          ? "border-(--accent) bg-(--accent-bg) text-(--accent)"
                          : "border-(--border) bg-(--input-bg) text-(--text-h) hover:-translate-y-px hover:border-(--accent-border)"
                      }`}
                      key={option.value}
                      onClick={() =>
                        appendLengthSelector.onChange(option.value)
                      }
                      type="button"
                    >
                      <span aria-hidden="true">{option.label}</span>
                      <span className="sr-only">{option.assistiveText}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
            {copy.label}
            <textarea
              aria-describedby={error !== undefined ? errorId : undefined}
              aria-invalid={error !== undefined}
              className="box-border max-h-40 min-h-24 w-full resize-y rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-base leading-7 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-(--text) focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)]"
              maxLength={copy.maxLength}
              onChange={(event) => onChange(event.currentTarget.value)}
              placeholder={copy.placeholder}
              ref={textareaRef}
              value={value}
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
            className="min-h-12 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
            type="submit"
          >
            {copy.submitText}
          </button>
        </form>
      </section>
    </>
  );
}
