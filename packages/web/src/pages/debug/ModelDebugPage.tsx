import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextStreamCompletedEvent,
} from "@kimiko/schema";
import type { LlmTextStreamHandle } from "../../llm/llmApi";
import { startLlmTextStream } from "../../llm/llmApi";

type ModelDebugStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

interface PromptValidationResult {
  readonly request: GenerateLlmTextRequest | null;
  readonly systemPromptChars: number;
  readonly userPromptChars: number;
  readonly fieldErrors: Readonly<{
    systemPrompt?: string;
    userPrompt?: string;
  }>;
}

const systemPromptLimit = 8_000;
const userPromptLimit = 20_000;
const systemPromptPlaceholder =
  "例如：你是一个严谨的代码助手，优先给出准确、简洁、可执行的答案。";
const userPromptPlaceholder =
  "例如：请解释这段代码的问题，并给出修复建议。";

export function ModelDebugPage(): JSX.Element {
  const navigate = useNavigate();
  const isMountedRef = useRef<boolean>(false);
  const streamHandleRef = useRef<LlmTextStreamHandle | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [status, setStatus] = useState<ModelDebugStatus>("idle");
  const [outputText, setOutputText] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [completedEvent, setCompletedEvent] =
    useState<GenerateLlmTextStreamCompletedEvent | null>(null);

  const validation = useMemo<PromptValidationResult>(
    () => validatePromptInputs(systemPrompt, userPrompt),
    [systemPrompt, userPrompt],
  );
  const isGenerating = status === "connecting" || status === "streaming";
  const shouldShowSystemPromptError =
    hasAttemptedSubmit ||
    systemPrompt.trim().length > 0 ||
    validation.fieldErrors.systemPrompt !== undefined;
  const shouldShowUserPromptError =
    hasAttemptedSubmit || userPrompt.length > 0 || userPrompt.trim().length > 0;

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      streamHandleRef.current?.close();
      streamHandleRef.current = null;
    };
  }, []);

  function handleSubmitOrCancel(): void {
    if (isGenerating) {
      streamHandleRef.current?.cancel();
      return;
    }

    setHasAttemptedSubmit(true);
    if (validation.request === null) {
      return;
    }

    streamHandleRef.current?.close();
    setStatus("connecting");
    setOutputText("");
    setErrorMessage("");
    setCompletedEvent(null);

    streamHandleRef.current = startLlmTextStream(validation.request, {
      onStarted: () => {
        if (!isMountedRef.current) {
          return;
        }

        setStatus("streaming");
      },
      onChunk: (delta) => {
        if (!isMountedRef.current) {
          return;
        }

        setStatus("streaming");
        setOutputText((currentValue) => currentValue + delta);
      },
      onCompleted: (event) => {
        streamHandleRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        setCompletedEvent(event);
        setErrorMessage("");
        setStatus("completed");
      },
      onCancelled: () => {
        streamHandleRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        setCompletedEvent(null);
        setErrorMessage("");
        setStatus("cancelled");
      },
      onError: (message) => {
        streamHandleRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        setCompletedEvent(null);
        setErrorMessage(message);
        setStatus("failed");
      },
      onAuthRequired: () => {
        streamHandleRef.current = null;
        if (!isMountedRef.current) {
          return;
        }

        void navigate("/login", { replace: true });
      },
    });
  }

  return (
    <main
      aria-label="模型调试页面"
      className="min-h-svh px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:py-10"
    >
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold text-(--accent)">
                Model Debug
              </p>
              <h1 className="mt-1 mb-0 text-2xl font-bold text-(--text-h)">
                模型调试
              </h1>
              <p className="mt-2 mb-0 text-sm leading-6 text-(--text)">
                隐藏路由页面，直接调用服务端当前配置的 LLM，支持流式输出。
              </p>
            </div>
            <button
              className="min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h)"
              onClick={() => {
                void navigate("/");
              }}
              type="button"
            >
              返回首页
            </button>
          </div>
        </header>

        <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmitOrCancel();
            }}
          >
            <PromptField
              description="可选。留空时不会向模型发送 system prompt。"
              disabled={isGenerating}
              errorMessage={
                shouldShowSystemPromptError
                  ? validation.fieldErrors.systemPrompt
                  : undefined
              }
              label="系统提示词"
              limit={systemPromptLimit}
              onChange={setSystemPrompt}
              placeholder={systemPromptPlaceholder}
              value={systemPrompt}
              visibleChars={validation.systemPromptChars}
            />

            <PromptField
              description="必填。提交时会按去首尾空白后的内容校验。"
              disabled={isGenerating}
              errorMessage={
                shouldShowUserPromptError
                  ? validation.fieldErrors.userPrompt
                  : undefined
              }
              label="用户提示词"
              limit={userPromptLimit}
              onChange={setUserPrompt}
              placeholder={userPromptPlaceholder}
              value={userPrompt}
              visibleChars={validation.userPromptChars}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge status={status} />
              <button
                className="min-h-11 rounded-2xl border-0 bg-(--accent) px-5 py-3 font-bold text-white transition-[filter,transform] duration-200 enabled:cursor-pointer enabled:hover:-translate-y-px enabled:hover:brightness-[1.06] disabled:cursor-not-allowed disabled:opacity-70"
                disabled={!isGenerating && validation.request === null}
                type="submit"
              >
                {isGenerating ? "取消生成" : "发送"}
              </button>
            </div>
          </form>
        </section>

        {status === "cancelled" ? (
          <NoticeCard tone="neutral">已取消生成，已保留当前收到的部分输出。</NoticeCard>
        ) : null}

        {status === "failed" && errorMessage.length > 0 ? (
          <NoticeCard tone="danger">{errorMessage}</NoticeCard>
        ) : null}

        <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="m-0 text-lg font-bold text-(--text-h)">输出结果</h2>
              <p className="mt-1 mb-0 text-sm leading-6 text-(--text)">
                结果按原始文本流式追加展示，不做 Markdown 渲染。
              </p>
            </div>
          </div>

          <pre className="mt-5 min-h-64 overflow-x-auto rounded-2xl border border-(--border) bg-(--input-bg) p-4 text-sm leading-7 whitespace-pre-wrap break-words text-(--text-h)">
            {getOutputPlaceholder(status, outputText)}
          </pre>
        </section>

        {completedEvent !== null ? (
          <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
            <h2 className="m-0 text-lg font-bold text-(--text-h)">完成元数据</h2>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2">
              <MetadataItem label="模型" value={completedEvent.model} />
              <MetadataItem
                label="Finish Reason"
                value={completedEvent.finishReason ?? "未返回"}
              />
              <MetadataItem
                label="耗时"
                value={`${completedEvent.elapsedMs} ms`}
              />
              <MetadataItem
                label="输入 Token"
                value={String(completedEvent.usage.inputTokens)}
              />
              <MetadataItem
                label="输出 Token"
                value={String(completedEvent.usage.outputTokens)}
              />
              <MetadataItem
                label="总 Token"
                value={String(completedEvent.usage.totalTokens)}
              />
            </dl>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function PromptField({
  description,
  disabled,
  errorMessage,
  label,
  limit,
  onChange,
  placeholder,
  value,
  visibleChars,
}: {
  readonly description: string;
  readonly disabled: boolean;
  readonly errorMessage?: string | undefined;
  readonly label: string;
  readonly limit: number;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly value: string;
  readonly visibleChars: number;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-2 text-sm font-semibold text-(--text-h)">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-xs font-medium text-(--text)">
          {visibleChars} / {limit}
        </span>
      </div>
      <textarea
        className="min-h-44 resize-y rounded-2xl border border-(--border) bg-(--input-bg) px-4 py-3 text-sm leading-6 text-(--text-h) outline-none transition-[border-color,box-shadow] duration-200 focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        placeholder={placeholder}
        rows={8}
        spellCheck={false}
        value={value}
      />
      <span className="text-xs leading-5 text-(--text)">{description}</span>
      {errorMessage !== undefined ? (
        <span className="rounded-xl bg-(--danger-bg) px-3 py-2 text-sm font-normal text-(--danger)">
          {errorMessage}
        </span>
      ) : null}
    </label>
  );
}

function StatusBadge({
  status,
}: {
  readonly status: ModelDebugStatus;
}): JSX.Element {
  const badge = getStatusBadge(status);

  return (
    <span
      className={`inline-flex min-h-10 items-center rounded-full px-4 py-2 text-sm font-semibold ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

function NoticeCard({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: "danger" | "neutral";
}): JSX.Element {
  const className =
    tone === "danger"
      ? "border-(--danger) bg-(--danger-bg) text-(--danger)"
      : "border-(--border) bg-(--panel-bg) text-(--text-h)";

  return (
    <section className={`rounded-3xl border p-5 shadow-(--shadow) ${className}`}>
      <p className="m-0 text-sm leading-6">{children}</p>
    </section>
  );
}

function MetadataItem({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-(--border) bg-(--input-bg) p-4">
      <dt className="text-xs font-semibold tracking-[0.02em] text-(--text)">
        {label}
      </dt>
      <dd className="mt-2 mb-0 text-sm font-bold text-(--text-h)">{value}</dd>
    </div>
  );
}

function validatePromptInputs(
  systemPrompt: string,
  userPrompt: string,
): PromptValidationResult {
  const normalizedSystemPrompt = systemPrompt.trim();
  const normalizedUserPrompt = userPrompt.trim();
  const fieldErrors: {
    systemPrompt?: string;
    userPrompt?: string;
  } = {};

  if (normalizedSystemPrompt.length > systemPromptLimit) {
    fieldErrors.systemPrompt = `系统提示词不能超过 ${systemPromptLimit} 字`;
  }

  if (normalizedUserPrompt.length === 0) {
    fieldErrors.userPrompt = "请输入用户提示词";
  } else if (normalizedUserPrompt.length > userPromptLimit) {
    fieldErrors.userPrompt = `用户提示词不能超过 ${userPromptLimit} 字`;
  }

  const request =
    fieldErrors.systemPrompt === undefined &&
    fieldErrors.userPrompt === undefined
      ? {
          userPrompt: normalizedUserPrompt,
          ...(normalizedSystemPrompt.length > 0
            ? { systemPrompt: normalizedSystemPrompt }
            : {}),
        }
      : null;

  return {
    request,
    systemPromptChars: normalizedSystemPrompt.length,
    userPromptChars: normalizedUserPrompt.length,
    fieldErrors,
  };
}

function getStatusBadge(
  status: ModelDebugStatus,
): Readonly<{ className: string; label: string }> {
  switch (status) {
    case "idle":
      return {
        className: "border border-(--border) bg-transparent text-(--text-h)",
        label: "待发送",
      };
    case "connecting":
      return {
        className: "border border-(--accent-border) bg-(--accent-bg) text-(--text-h)",
        label: "建立连接中",
      };
    case "streaming":
      return {
        className: "border border-(--accent-border) bg-(--accent-bg) text-(--text-h)",
        label: "流式生成中",
      };
    case "completed":
      return {
        className: "border border-(--accent-border) bg-(--accent-bg) text-(--text-h)",
        label: "已完成",
      };
    case "cancelled":
      return {
        className: "border border-(--border) bg-transparent text-(--text-h)",
        label: "已取消",
      };
    case "failed":
      return {
        className: "border border-(--danger) bg-(--danger-bg) text-(--danger)",
        label: "生成失败",
      };
  }
}

function getOutputPlaceholder(
  status: ModelDebugStatus,
  outputText: string,
): string {
  if (outputText.length > 0) {
    return outputText;
  }

  switch (status) {
    case "connecting":
      return "正在建立连接...";
    case "streaming":
      return "正在等待模型输出...";
    case "completed":
      return "模型已完成，但没有返回正文输出。";
    case "cancelled":
      return "已取消生成。";
    case "failed":
      return "生成失败。";
    case "idle":
      return "输出结果会显示在这里。";
  }
}
