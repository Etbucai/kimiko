import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ContinueStoryRequest } from "@kimiko/schema";
import type { StoryRealtimeGenerationHandle } from "../../story/storyRealtimeApi";
import { startStoryRealtimeGeneration } from "../../story/storyRealtimeApi";
import type {
  StoryFieldErrors,
  StoryFieldName,
  StoryFormState,
} from "./StoryForm";
import { StoryForm } from "./StoryForm";
import type { StoryStreamingResult } from "./StoryResult";
import { StoryResult } from "./StoryResult";

type StoryGenerationStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

type StoryFormValidationResult =
  | Readonly<{ success: true; request: ContinueStoryRequest }>
  | Readonly<{ success: false; fieldErrors: StoryFieldErrors }>;

const initialFormState: StoryFormState = {
  storyText: "",
  instruction: "",
};

const generationFailureMessage = "生成失败，请稍后重试";
const generationCancelledMessage = "已取消生成";

export function StoryPage(): JSX.Element {
  const navigate = useNavigate();
  const generationHandleRef = useRef<StoryRealtimeGenerationHandle | null>(null);
  const [formState, setFormState] =
    useState<StoryFormState>(initialFormState);
  const [fieldErrors, setFieldErrors] = useState<StoryFieldErrors>({});
  const [status, setStatus] = useState<StoryGenerationStatus>("idle");
  const [result, setResult] = useState<StoryStreamingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const isGenerating = status === "connecting" || status === "streaming";

  useEffect(() => {
    return () => {
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
    };
  }, []);

  function handleChange(field: StoryFieldName, value: string): void {
    setFormState((previousFormState) => ({
      ...previousFormState,
      [field]: value,
    }));
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, field),
    );
  }

  function handleSubmit(): void {
    if (isGenerating) {
      return;
    }

    const validationResult = validateStoryForm(formState);
    if (!validationResult.success) {
      setFieldErrors(validationResult.fieldErrors);
      return;
    }

    setFieldErrors({});
    setResult(null);
    setErrorMessage("");
    setStatus("connecting");
    generationHandleRef.current?.close();

    generationHandleRef.current = startStoryRealtimeGeneration(
      validationResult.request,
      {
        onStarted() {
          setStatus("streaming");
        },
        onChunk(delta) {
          setStatus("streaming");
          setResult((previousResult) => ({
            continuedStory: `${previousResult?.continuedStory ?? ""}${delta}`,
          }));
        },
        onCompleted(event) {
          generationHandleRef.current = null;
          setResult({
            continuedStory: event.continuedStory,
            model: event.model,
            elapsedMs: event.elapsedMs,
            usage: event.usage,
          });
          setStatus("completed");
        },
        onCancelled() {
          generationHandleRef.current = null;
          setResult(
            (previousResult) => previousResult ?? { continuedStory: "" },
          );
          setStatus("cancelled");
        },
        onError(message) {
          generationHandleRef.current = null;
          setErrorMessage(message);
          setResult(
            (previousResult) => previousResult ?? { continuedStory: "" },
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

  const resultStatus = getResultStatus(status);
  const resultStatusMessage = getResultStatusMessage(status, errorMessage);

  return (
    <main
      aria-label="StoryAgent"
      className="min-h-svh px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:py-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7">
          <StoryForm
            fieldErrors={fieldErrors}
            isGenerating={isGenerating}
            onCancel={handleCancel}
            onChange={handleChange}
            onSubmit={handleSubmit}
            value={formState}
          />
        </div>

        {result !== null && resultStatus !== null ? (
          <StoryResult
            result={result}
            status={resultStatus}
            statusMessage={resultStatusMessage}
          />
        ) : null}
      </section>
    </main>
  );
}

function validateStoryForm(
  formState: StoryFormState,
): StoryFormValidationResult {
  const storyText = formState.storyText.trim();
  const instruction = formState.instruction.trim();
  const fieldErrors: StoryFieldErrors = {};

  if (storyText.length === 0) {
    fieldErrors.storyText = "请输入故事正文";
  }

  if (instruction.length === 0) {
    fieldErrors.instruction = "请输入续写指令";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      fieldErrors,
    };
  }

  return {
    success: true,
    request: {
      storyText,
      instruction,
    },
  };
}

function removeFieldError(
  fieldErrors: StoryFieldErrors,
  field: StoryFieldName,
): StoryFieldErrors {
  if (fieldErrors[field] === undefined) {
    return fieldErrors;
  }

  const nextFieldErrors = { ...fieldErrors };
  delete nextFieldErrors[field];
  return nextFieldErrors;
}

function getResultStatus(
  status: StoryGenerationStatus,
): "streaming" | "completed" | "cancelled" | "failed" | null {
  if (status === "streaming") {
    return "streaming";
  }

  if (status === "completed") {
    return "completed";
  }

  if (status === "cancelled") {
    return "cancelled";
  }

  if (status === "failed") {
    return "failed";
  }

  return null;
}

function getResultStatusMessage(
  status: StoryGenerationStatus,
  errorMessage: string,
): string | undefined {
  if (status === "cancelled") {
    return generationCancelledMessage;
  }

  if (status === "failed") {
    return errorMessage.length > 0 ? errorMessage : generationFailureMessage;
  }

  return undefined;
}
