import type { JSX } from "react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { ContinueStoryRequest, ContinueStoryResponse } from "@kimiko/schema";
import {
  continueStory,
  StoryAuthRequiredError,
} from "../../story/storyApi";
import type {
  StoryFieldErrors,
  StoryFieldName,
  StoryFormState,
} from "./StoryForm";
import { StoryForm } from "./StoryForm";
import { StoryResult } from "./StoryResult";

type StoryGenerationStatus = "idle" | "submitting" | "succeeded" | "failed";

type StoryFormValidationResult =
  | Readonly<{ success: true; request: ContinueStoryRequest }>
  | Readonly<{ success: false; fieldErrors: StoryFieldErrors }>;

const initialFormState: StoryFormState = {
  storyText: "",
  instruction: "",
};

const generationFailureMessage = "生成失败，请稍后重试";

export function StoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [formState, setFormState] =
    useState<StoryFormState>(initialFormState);
  const [fieldErrors, setFieldErrors] = useState<StoryFieldErrors>({});
  const [status, setStatus] = useState<StoryGenerationStatus>("idle");
  const [result, setResult] = useState<ContinueStoryResponse | null>(null);
  const isSubmitting = status === "submitting";

  function handleChange(field: StoryFieldName, value: string): void {
    setFormState((previousFormState) => ({
      ...previousFormState,
      [field]: value,
    }));
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, field),
    );
  }

  async function handleSubmit(): Promise<void> {
    const validationResult = validateStoryForm(formState);
    if (!validationResult.success) {
      setFieldErrors(validationResult.fieldErrors);
      return;
    }

    setFieldErrors({});
    setResult(null);
    setStatus("submitting");

    try {
      const nextResult = await continueStory(validationResult.request);
      setResult(nextResult);
      setStatus("succeeded");
    } catch (error: unknown) {
      if (error instanceof StoryAuthRequiredError) {
        void navigate("/login", { replace: true });
        return;
      }

      setStatus("failed");
    }
  }

  return (
    <main
      aria-label="StoryAgent"
      className="min-h-svh px-4 py-6 [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:py-10"
    >
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="rounded-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-5 shadow-[var(--shadow)] md:p-7">
          <StoryForm
            disabled={isSubmitting}
            fieldErrors={fieldErrors}
            onChange={handleChange}
            onSubmit={handleSubmit}
            value={formState}
          />
        </div>

        {status === "failed" ? (
          <p
            className="m-0 rounded-2xl bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
            role="alert"
          >
            {generationFailureMessage}
          </p>
        ) : null}

        {status === "succeeded" && result !== null ? (
          <StoryResult result={result} />
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
