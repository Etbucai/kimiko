import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  StoryContinuePayload,
  StorylineGenerationMetadata,
  StorylineSnapshot,
} from "@kimiko/schema";
import type { StoryRealtimeGenerationHandle } from "../../story/storyRealtimeApi";
import { startStoryRealtimeGeneration } from "../../story/storyRealtimeApi";
import { getRecentStoryline } from "../../story/storylineApi";
import { StoryInitialInput } from "./StoryInitialInput";
import { StorylineComposer } from "./StorylineComposer";
import { StorylineReader } from "./StorylineReader";
import { StorylineRestoreError } from "./StorylineRestoreError";

type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
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

const generationFailureMessage = "生成失败，请稍后重试";
const generationCancelledMessage = "已取消生成";
const restoreFailureMessage = "恢复故事线失败，请稍后重试";
const bottomScrollThresholdPx = 140;

export function StoryPage(): JSX.Element {
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
  const [restoreErrorMessage, setRestoreErrorMessage] = useState(
    restoreFailureMessage,
  );
  const [generationStatusMessage, setGenerationStatusMessage] = useState("");

  const isGenerating = status === "connecting" || status === "streaming";
  const isComposerVisible = status !== "loading" && status !== "restoreFailed";

  const restoreStoryline = useCallback(async (): Promise<void> => {
    const requestId = restoreRequestIdRef.current + 1;
    restoreRequestIdRef.current = requestId;

    generationHandleRef.current?.close();
    generationHandleRef.current = null;
    setStatus("loading");
    setTemporaryGeneratedText("");
    setFieldErrors({});
    setGenerationStatusMessage("");

    const result = await getRecentStoryline();
    if (!isMountedRef.current || restoreRequestIdRef.current !== requestId) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
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
  }, [navigate]);

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
  }, [storyline, temporaryGeneratedText]);

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
        onCompleted(event) {
          generationHandleRef.current = null;
          shouldFollowScrollRef.current = isNearBottom();
          setStoryline(event.storyline);
          setTemporaryGeneratedText("");
          setInitialStoryText("");
          setInstruction("");
          setGenerationStatusMessage("");
          setStatus("completed");
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

  const latestGeneration = storyline?.latestGeneration ?? null;

  return (
    <main
      aria-label="StoryAgent"
      className="min-h-svh px-4 pt-6 pb-64 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:pt-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {status === "loading" ? <StorylineLoading /> : null}

        {status === "restoreFailed" ? (
          <StorylineRestoreError
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
                isStreaming={status === "streaming"}
                storyline={storyline}
                temporaryGeneratedText={temporaryGeneratedText}
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
                    isStreaming={status === "streaming"}
                    text={temporaryGeneratedText}
                  />
                ) : null}
              </>
            )}

            {latestGeneration !== null ? (
              <LatestGenerationMetadata metadata={latestGeneration} />
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
  isStreaming: boolean;
  text: string;
}

function TemporaryGeneratedText({
  isStreaming,
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
      {isStreaming ? (
        <p className="mt-4 mb-0 text-xs text-[var(--text)]" role="status">
          正在生成...
        </p>
      ) : null}
    </article>
  );
}

interface LatestGenerationMetadataProps {
  metadata: StorylineGenerationMetadata;
}

function LatestGenerationMetadata({
  metadata,
}: LatestGenerationMetadataProps): JSX.Element {
  return (
    <p className="m-0 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 text-xs leading-5 text-[var(--text)]">
      模型：{metadata.model} / 耗时：{metadata.elapsedMs}ms / Token：
      {metadata.usage.totalTokens}
    </p>
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
