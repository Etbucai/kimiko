import type { JSX } from "react";
import { useEffect, useState } from "react";
import {
  CircleStop,
  MessageCircle,
  PenLine,
  Plus,
  RefreshCcw,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type StoryActionKind = "append" | "rewrite" | "dialogue";

interface StoryActionFabProps {
  availableActions: readonly StoryActionKind[];
  hasBottomBar: boolean;
  isGenerating: boolean;
  isVisible: boolean;
  onCancelGeneration: () => void;
  onSelectAction: (action: StoryActionKind) => void;
}

const actionConfig: Record<
  StoryActionKind,
  Readonly<{ label: string; Icon: LucideIcon }>
> = {
  append: {
    label: "续写",
    Icon: PenLine,
  },
  rewrite: {
    label: "重写",
    Icon: RefreshCcw,
  },
  dialogue: {
    label: "互动",
    Icon: MessageCircle,
  },
};

export function StoryActionFab({
  availableActions,
  hasBottomBar,
  isGenerating,
  isVisible,
  onCancelGeneration,
  onSelectAction,
}: StoryActionFabProps): JSX.Element | null {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const shouldShowMenu = isVisible && !isGenerating && isMenuOpen;
  const bottomClassName = hasBottomBar
    ? "bottom-[calc(5rem+env(safe-area-inset-bottom))]"
    : "bottom-[calc(1rem+env(safe-area-inset-bottom))]";

  useEffect(() => {
    if (!shouldShowMenu) {
      return undefined;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shouldShowMenu]);

  if (!isVisible) {
    return null;
  }

  if (isGenerating) {
    return (
      <button
        aria-label="取消生成"
        className={`fixed right-4 ${bottomClassName} z-30 flex h-14 w-14 items-center justify-center rounded-full border-0 bg-(--danger) text-white shadow-(--shadow) transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]`}
        onClick={onCancelGeneration}
        type="button"
      >
        <CircleStop aria-hidden size={24} strokeWidth={2.4} />
      </button>
    );
  }

  return (
    <>
      {shouldShowMenu ? (
        <button
          aria-label="关闭故事操作"
          className="fixed inset-0 z-20 cursor-default border-0 bg-transparent"
          onClick={() => setIsMenuOpen(false)}
          type="button"
        />
      ) : null}

      <div
        className={`fixed right-4 ${bottomClassName} z-30 flex flex-col items-center gap-3`}
      >
        {shouldShowMenu
          ? availableActions.map((action) => {
              const { Icon, label } = actionConfig[action];
              return (
                <button
                  aria-label={label}
                  className="flex h-12 w-12 items-center justify-center rounded-full border border-(--border) bg-(--panel-bg) text-(--text-h) shadow-(--shadow) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
                  key={action}
                  onClick={() => {
                    setIsMenuOpen(false);
                    onSelectAction(action);
                  }}
                  type="button"
                >
                  <Icon aria-hidden size={21} strokeWidth={2.3} />
                </button>
              );
            })
          : null}

        <button
          aria-label={isMenuOpen ? "关闭故事操作" : "打开故事操作"}
          className="flex h-14 w-14 items-center justify-center rounded-full border-0 bg-(--accent) text-white shadow-(--shadow) transition-[filter,transform] duration-200 hover:-translate-y-px hover:brightness-[1.06]"
          onClick={() => setIsMenuOpen((currentValue) => !currentValue)}
          type="button"
        >
          {shouldShowMenu ? (
            <X aria-hidden size={24} strokeWidth={2.4} />
          ) : (
            <Plus aria-hidden size={26} strokeWidth={2.4} />
          )}
        </button>
      </div>
    </>
  );
}
