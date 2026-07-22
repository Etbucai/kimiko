import type { JSX } from "react";
import type { StoryCharacterSummarySnapshot } from "@kimiko/schema";

interface StorySummaryDrawerProps {
  errorMessage: string;
  isOpen: boolean;
  onClose: () => void;
  onRetry: () => void;
  status: "idle" | "loading" | "success" | "failed";
  summary: StoryCharacterSummarySnapshot | null;
}

export function StorySummaryDrawer({
  errorMessage,
  isOpen,
  onClose,
  onRetry,
  status,
  summary,
}: StorySummaryDrawerProps): JSX.Element | null {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/35 px-3 pb-3 backdrop-blur-sm md:items-center md:justify-center md:p-6">
      <section
        aria-label="角色摘要"
        className="max-h-[82svh] w-full overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:max-w-2xl md:p-6"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="m-0 text-lg font-bold text-[var(--text-h)]">
              当前角色摘要
            </h2>
            <p className="mt-1 mb-0 text-sm leading-6 text-[var(--text)]">
              只读展示当前已保存的角色身份、关系和状态。
            </p>
          </div>
          <button
            className="rounded-full border border-[var(--border)] bg-transparent px-3 py-1 text-sm text-[var(--text)]"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </div>

        <div className="mt-5">
          {status === "loading" || status === "idle" ? (
            <p className="m-0 text-sm text-[var(--text)]" role="status">
              正在获取角色摘要...
            </p>
          ) : null}

          {status === "failed" ? (
            <div className="flex flex-col gap-3">
              <p
                className="m-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
                role="alert"
              >
                {errorMessage}
              </p>
              <button
                className="min-h-11 rounded-2xl border-0 bg-[var(--accent)] px-4 py-2 font-bold text-white"
                onClick={onRetry}
                type="button"
              >
                重试
              </button>
            </div>
          ) : null}

          {status === "success" ? (
            summary === null || summary.characters.length === 0 ? (
              <p className="m-0 rounded-2xl border border-[var(--border)] px-4 py-4 text-sm leading-6 text-[var(--text)]">
                暂无角色摘要，完成一次续写后再查看。
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {summary.characters.map((character) => (
                  <article
                    className="rounded-2xl border border-[var(--border)] bg-[var(--input-bg)] p-4"
                    key={character.name}
                  >
                    <h3 className="m-0 text-base font-bold text-[var(--text-h)]">
                      {character.name}
                    </h3>
                    {character.aliases.length > 0 ? (
                      <p className="mt-1 mb-0 text-xs text-[var(--text)]">
                        别名：{character.aliases.join("、")}
                      </p>
                    ) : null}
                    <SummaryField label="身份" value={character.identity} />
                    <SummaryList
                      label="关系"
                      values={character.relationships}
                    />
                    <SummaryField label="动机" value={character.motivation} />
                    <SummaryField
                      label="当前状态"
                      value={character.currentStatus}
                    />
                  </article>
                ))}
              </div>
            )
          ) : null}
        </div>
      </section>
    </div>
  );
}

interface SummaryFieldProps {
  label: string;
  value: string;
}

function SummaryField({ label, value }: SummaryFieldProps): JSX.Element | null {
  if (value.length === 0) {
    return null;
  }

  return (
    <p className="mt-3 mb-0 text-sm leading-6 text-[var(--text-h)]">
      <span className="font-semibold">{label}：</span>
      {value}
    </p>
  );
}

interface SummaryListProps {
  label: string;
  values: readonly string[];
}

function SummaryList({ label, values }: SummaryListProps): JSX.Element | null {
  if (values.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 text-sm leading-6 text-[var(--text-h)]">
      <span className="font-semibold">{label}：</span>
      <ul className="mt-1 mb-0 list-disc pl-5">
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  );
}
