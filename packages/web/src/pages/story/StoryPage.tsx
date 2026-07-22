import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  StoryCharacterSummarySnapshot,
  StoryContinuePayload,
  StorylineGenerationMetadata,
  StorylineId,
  StorylineSnapshot,
} from "@kimiko/schema";
import type { StoryRealtimeGenerationHandle } from "../../story/storyRealtimeApi";
import { startStoryRealtimeGeneration } from "../../story/storyRealtimeApi";
import {
  getRecentStoryline,
  getStoryline,
  getStorylineSummary,
} from "../../story/storylineApi";
import { StoryInitialInput } from "./StoryInitialInput";
import { StorylineComposer } from "./StorylineComposer";
import { StorylineReader } from "./StorylineReader";
import { StorylineRestoreError } from "./StorylineRestoreError";
import { StorySummaryDrawer } from "./StorySummaryDrawer";

type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
  | "summarizing"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";

interface StorylineFieldErrors {
  initialStoryText?: string;
  instruction?: string;
}

type PayloadValidationResult =
  | Readonly<{ success: true; payload: StoryContinuePayload }>
  | Readonly<{ success: false; fieldErrors: StorylineFieldErrors }>;

type TemporaryTextStatus = "streaming" | "summarizing" | null;
type SummaryDrawerStatus = "idle" | "loading" | "success" | "failed";

type StoryPageMode = "recent" | "detail" | "new";

interface StoryPageProps {
  mode: StoryPageMode;
  storylineId?: StorylineId | undefined;
}

const generationFailureMessage = "生成失败，请稍后重试";
const generationCancelledMessage = "已取消生成";
const restoreFailureMessage = "恢复故事线失败，请稍后重试";
const notFoundFailureTitle = "故事线不可用";
const summaryFailureMessage = "获取角色摘要失败，请稍后重试";
const bottomScrollThresholdPx = 140;

export function StoryPage({
  mode,
  storylineId,
}: StoryPageProps): JSX.Element {
  const navigate = useNavigate();
  const generationHandleRef = useRef<StoryRealtimeGenerationHandle | null>(null);
  const isMountedRef = useRef(false);
  const restoreRequestIdRef = useRef(0);
  const shouldFollowScrollRef = useRef(true);

  const [status, setStatus] = useState<StorylinePageStatus>("loading");
  const [storyline, setStoryline] = useState<StorylineSnapshot | null>(null);
  const [initialStoryText, setInitialStoryText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [temporaryGeneratedText, setTemporaryGeneratedText] = useState("");
  const [fieldErrors, setFieldErrors] = useState<StorylineFieldErrors>({});
  const [restoreErrorTitle, setRestoreErrorTitle] =
    useState("故事线恢复失败");
  const [restoreErrorMessage, setRestoreErrorMessage] = useState(
    restoreFailureMessage,
  );
  const [generationStatusMessage, setGenerationStatusMessage] = useState("");
  const [isSummaryDrawerOpen, setIsSummaryDrawerOpen] = useState(false);
  const [summaryDrawerStatus, setSummaryDrawerStatus] =
    useState<SummaryDrawerStatus>("idle");
  const [characterSummary, setCharacterSummary] =
    useState<StoryCharacterSummarySnapshot | null>(null);
  const [summaryErrorMessage, setSummaryErrorMessage] = useState(
    summaryFailureMessage,
  );

  const isGenerating =
    status === "connecting" ||
    status === "streaming" ||
    status === "summarizing";
  const isComposerVisible = status !== "loading" && status !== "restoreFailed";
  const temporaryTextStatus = getTemporaryTextStatus(status);

  const restoreStoryline = useCallback(async (): Promise<void> => {
    const requestId = restoreRequestIdRef.current + 1;
    restoreRequestIdRef.current = requestId;

    generationHandleRef.current?.close();
    generationHandleRef.current = null;
    setStatus("loading");
    setTemporaryGeneratedText("");
    setFieldErrors({});
    setRestoreErrorTitle("故事线恢复失败");
    setRestoreErrorMessage(restoreFailureMessage);
    setGenerationStatusMessage("");
    setIsSummaryDrawerOpen(false);
    setSummaryDrawerStatus("idle");
    setCharacterSummary(null);
    setSummaryErrorMessage(summaryFailureMessage);

    if (mode === "new") {
      setStoryline(null);
      setInitialStoryText("");
      setInstruction("");
      setStatus("empty");
      return;
    }

    if (mode === "detail" && storylineId === undefined) {
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage("故事线不存在或已不可用");
      setStatus("restoreFailed");
      return;
    }

    const result =
      mode === "detail" && storylineId !== undefined
        ? await getStoryline(storylineId)
        : await getRecentStoryline();
    if (!isMountedRef.current || restoreRequestIdRef.current !== requestId) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "notFound") {
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage(result.message);
      setStatus("restoreFailed");
      return;
    }

    if (result.status === "failed") {
      setStoryline(null);
      setRestoreErrorMessage(result.message);
      setStatus("restoreFailed");
      return;
    }

    setStoryline(result.storyline);
    setInitialStoryText("");
    setInstruction("");
    setStatus(result.storyline === null ? "empty" : "ready");
  }, [mode, navigate, storylineId]);

  useEffect(() => {
    isMountedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void restoreStoryline();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      isMountedRef.current = false;
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
    };
  }, [restoreStoryline]);

  useEffect(() => {
    if (!shouldFollowScrollRef.current) {
      return undefined;
    }

    const frameId = requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth",
      });
    });

    return () => cancelAnimationFrame(frameId);
  }, [status, storyline, temporaryGeneratedText]);

  function handleInitialStoryTextChange(value: string): void {
    setInitialStoryText(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "initialStoryText"),
    );
  }

  function handleInstructionChange(value: string): void {
    setInstruction(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "instruction"),
    );
  }

  function handleSubmit(): void {
    if (isGenerating) {
      handleCancel();
      return;
    }

    const validationResult = validatePayload({
      initialStoryText,
      instruction,
      storyline,
    });
    if (!validationResult.success) {
      setFieldErrors(validationResult.fieldErrors);
      return;
    }

    shouldFollowScrollRef.current = isNearBottom();
    setFieldErrors({});
    setTemporaryGeneratedText("");
    setGenerationStatusMessage("");
    setStatus("connecting");
    generationHandleRef.current?.close();

    generationHandleRef.current = startStoryRealtimeGeneration(
      validationResult.payload,
      {
        onStarted() {
          shouldFollowScrollRef.current = isNearBottom();
          setStatus("streaming");
        },
        onChunk(delta) {
          shouldFollowScrollRef.current = isNearBottom();
          setStatus("streaming");
          setTemporaryGeneratedText((previousText) => `${previousText}${delta}`);
        },
        onSummaryStarted() {
          shouldFollowScrollRef.current = isNearBottom();
          setStatus("summarizing");
        },
        onCompleted(event) {
          generationHandleRef.current = null;
          shouldFollowScrollRef.current = isNearBottom();
          setStoryline(event.storyline);
          setTemporaryGeneratedText("");
          setInitialStoryText("");
          setInstruction("");
          setGenerationStatusMessage("");
          setStatus("completed");
          if (mode === "new") {
            void navigate(`/storylines/${event.storyline.id}`, {
              replace: true,
            });
          }
        },
        onCancelled() {
          generationHandleRef.current = null;
          setTemporaryGeneratedText("");
          setGenerationStatusMessage(generationCancelledMessage);
          setStatus("cancelled");
        },
        onError(message) {
          generationHandleRef.current = null;
          setTemporaryGeneratedText("");
          setGenerationStatusMessage(
            message.length > 0 ? message : generationFailureMessage,
          );
          setStatus("failed");
        },
        onAuthRequired() {
          generationHandleRef.current = null;
          void navigate("/login", { replace: true });
        },
      },
    );
  }

  function handleCancel(): void {
    generationHandleRef.current?.cancel();
  }

  function handleGoToStorylineList(): void {
    if (isGenerating) {
      const shouldLeave = window.confirm(
        "当前生成未完成，离开会取消本轮生成。确定返回故事列表吗？",
      );
      if (!shouldLeave) {
        return;
      }

      generationHandleRef.current?.cancel();
      void navigate("/storylines");
      return;
    }

    if (hasUnsavedDraft(initialStoryText, instruction)) {
      const shouldLeave = window.confirm(
        "当前输入尚未提交，离开会丢失。确定返回故事列表吗？",
      );
      if (!shouldLeave) {
        return;
      }
    }

    void navigate("/storylines");
  }

  function handleOpenSummary(): void {
    if (storyline === null) {
      return;
    }

    setIsSummaryDrawerOpen(true);
    void loadSummary(storyline.id);
  }

  function handleRetrySummary(): void {
    if (storyline === null) {
      return;
    }

    void loadSummary(storyline.id);
  }

  async function loadSummary(storylineId: string): Promise<void> {
    setSummaryDrawerStatus("loading");
    setSummaryErrorMessage(summaryFailureMessage);

    const result = await getStorylineSummary(storylineId);
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "failed") {
      setSummaryErrorMessage(result.message);
      setSummaryDrawerStatus("failed");
      return;
    }

    setCharacterSummary(result.summary);
    setSummaryDrawerStatus("success");
  }

  const latestGeneration = storyline?.latestGeneration ?? null;

  return (
    <main
      aria-label="StoryAgent"
      className="min-h-svh px-4 pt-6 pb-64 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:pt-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <StoryPageHeader onBackToList={handleGoToStorylineList} />

        {status === "loading" ? <StorylineLoading /> : null}

        {status === "restoreFailed" ? (
          <StorylineRestoreError
            title={restoreErrorTitle}
            message={restoreErrorMessage}
            onRetry={() => {
              void restoreStoryline();
            }}
          />
        ) : null}

        {status !== "loading" && status !== "restoreFailed" ? (
          <>
            {storyline !== null ? (
              <StorylineReader
                storyline={storyline}
                temporaryGeneratedText={temporaryGeneratedText}
                temporaryTextStatus={temporaryTextStatus}
              />
            ) : (
              <>
                <StoryInitialInput
                  disabled={isGenerating}
                  error={fieldErrors.initialStoryText}
                  onChange={handleInitialStoryTextChange}
                  value={initialStoryText}
                />
                {temporaryGeneratedText.length > 0 ? (
                  <TemporaryGeneratedText
                    status={temporaryTextStatus}
                    text={temporaryGeneratedText}
                  />
                ) : null}
              </>
            )}

            {latestGeneration !== null ? (
              <LatestGenerationMetadata
                metadata={latestGeneration}
                onOpenSummary={handleOpenSummary}
              />
            ) : null}

            {generationStatusMessage.length > 0 ? (
              <GenerationStatusMessage
                isError={status === "failed"}
                message={generationStatusMessage}
              />
            ) : null}
          </>
        ) : null}
      </section>

      {isComposerVisible ? (
        <StorylineComposer
          disabled={isGenerating}
          error={fieldErrors.instruction}
          isGenerating={isGenerating}
          onCancel={handleCancel}
          onChange={handleInstructionChange}
          onSubmit={handleSubmit}
          value={instruction}
        />
      ) : null}

      <StorySummaryDrawer
        errorMessage={summaryErrorMessage}
        isOpen={isSummaryDrawerOpen}
        onClose={() => setIsSummaryDrawerOpen(false)}
        onRetry={handleRetrySummary}
        status={summaryDrawerStatus}
        summary={characterSummary}
      />
    </main>
  );
}

interface ValidatePayloadInput {
  initialStoryText: string;
  instruction: string;
  storyline: StorylineSnapshot | null;
}

function validatePayload(input: ValidatePayloadInput): PayloadValidationResult {
  const instruction = input.instruction.trim();
  const fieldErrors: StorylineFieldErrors = {};

  if (instruction.length === 0) {
    fieldErrors.instruction = "请输入续写指令";
  }

  if (input.storyline === null) {
    const initialStoryText = input.initialStoryText.trim();
    if (initialStoryText.length === 0) {
      fieldErrors.initialStoryText = "请输入故事正文";
    }

    if (Object.keys(fieldErrors).length > 0) {
      return { success: false, fieldErrors };
    }

    return {
      success: true,
      payload: {
        mode: "create",
        initialStoryText,
        instruction,
      },
    };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { success: false, fieldErrors };
  }

  return {
    success: true,
    payload: {
      mode: "append",
      storylineId: input.storyline.id,
      instruction,
    },
  };
}

function isNearBottom(): boolean {
  const scrollBottom =
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  return scrollBottom <= bottomScrollThresholdPx;
}

function getTemporaryTextStatus(
  status: StorylinePageStatus,
): TemporaryTextStatus {
  switch (status) {
    case "streaming":
      return "streaming";
    case "summarizing":
      return "summarizing";
    default:
      return null;
  }
}

function removeFieldError(
  fieldErrors: StorylineFieldErrors,
  field: keyof StorylineFieldErrors,
): StorylineFieldErrors {
  if (fieldErrors[field] === undefined) {
    return fieldErrors;
  }

  const nextFieldErrors = { ...fieldErrors };
  delete nextFieldErrors[field];
  return nextFieldErrors;
}

function hasUnsavedDraft(initialStoryText: string, instruction: string): boolean {
  return initialStoryText.trim().length > 0 || instruction.trim().length > 0;
}

interface StoryPageHeaderProps {
  onBackToList: () => void;
}

function StoryPageHeader({
  onBackToList,
}: StoryPageHeaderProps): JSX.Element {
  return (
    <header className="flex flex-col gap-3 rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:flex-row md:items-center md:justify-between md:p-6">
      <div>
        <p className="m-0 text-sm font-semibold text-[var(--accent)]">
          StoryAgent
        </p>
        <h1 className="mt-1 mb-0 text-2xl font-bold text-[var(--text-h)]">
          故事工作台
        </h1>
      </div>
      <button
        className="min-h-11 rounded-2xl border border-[var(--border)] bg-transparent px-5 py-3 font-bold text-[var(--text-h)] transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-[var(--accent-border)]"
        onClick={onBackToList}
        type="button"
      >
        返回故事列表
      </button>
    </header>
  );
}

function StorylineLoading(): JSX.Element {
  return (
    <section
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center shadow-[var(--shadow)]"
      role="status"
    >
      <p className="m-0 text-base text-[var(--text)]">正在恢复故事线...</p>
    </section>
  );
}

interface TemporaryGeneratedTextProps {
  status: TemporaryTextStatus;
  text: string;
}

function TemporaryGeneratedText({
  status,
  text,
}: TemporaryGeneratedTextProps): JSX.Element {
  return (
    <article
      aria-label="正在生成的续写"
      className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7"
    >
      <p className="m-0 whitespace-pre-wrap text-base leading-8 text-[var(--text-h)]">
        {text}
      </p>
      {status !== null ? (
        <p className="mt-4 mb-0 text-xs text-[var(--text)]" role="status">
          {status === "streaming" ? "正在生成..." : "正在记录角色摘要..."}
        </p>
      ) : null}
    </article>
  );
}

interface LatestGenerationMetadataProps {
  metadata: StorylineGenerationMetadata;
  onOpenSummary: () => void;
}

function LatestGenerationMetadata({
  metadata,
  onOpenSummary,
}: LatestGenerationMetadataProps): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 text-xs leading-5 text-[var(--text)] md:flex-row md:items-center md:justify-between">
      <p className="m-0">
        模型：{metadata.model} / 耗时：{metadata.elapsedMs}ms / Token：
        {metadata.usage.totalTokens}
      </p>
      <button
        className="self-start rounded-full border border-[var(--border)] bg-transparent px-3 py-1 font-semibold text-[var(--text-h)] md:self-auto"
        onClick={onOpenSummary}
        type="button"
      >
        查看角色摘要
      </button>
    </div>
  );
}

interface GenerationStatusMessageProps {
  isError: boolean;
  message: string;
}

function GenerationStatusMessage({
  isError,
  message,
}: GenerationStatusMessageProps): JSX.Element {
  return (
    <p
      className="m-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
      role={isError ? "alert" : "status"}
    >
      {message}
    </p>
  );
}
