import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type {
  CompleteStorySettingRequest,
  StoryContinuePayload,
  StoryGenerationPhase,
  StoryGenerationTask,
  StorySetting,
  StorySettingId,
  StorySettingListItem,
  StorylineGenerationMetadata,
  StorylineSegmentId,
  StorylineId,
  StorylineSnapshot,
} from "@kimiko/schema";
import type {
  StoryRealtimeGenerationError,
  StoryRealtimeGenerationHandle,
} from "../../story/storyRealtimeApi";
import { getStoredAuthSession } from "../../auth/authApi";
import { startStoryRealtimeGeneration } from "../../story/storyRealtimeApi";
import {
  cancelStoryGeneration,
  getRecentStoryline,
  getStoryGenerationStatus,
  getStoryline,
} from "../../story/storylineApi";
import {
  createStorySetting,
  getStorySetting,
  listStorySettings,
  startStorySettingCompletionStream,
  type StorySettingCompletionHandle,
} from "../../story/storySettingApi";
import { StoryInitialInput } from "./StoryInitialInput";
import { StoryActionDrawer } from "./StoryActionDrawer";
import { StoryActionFab } from "./StoryActionFab";
import type { StoryActionKind } from "./StoryActionFab";
import {
  APPEND_TARGET_LENGTH_OPTIONS,
  readAppendTargetLengthPreference,
  writeAppendTargetLengthPreference,
  type AppendTargetLength,
} from "./append-target-length-preference";
import { StorylineComposer } from "./StorylineComposer";
import type { StorylineComposerMode } from "./StorylineComposer";
import { StorylineReader } from "./StorylineReader";
import type {
  RewriteDraftState,
  StorylineReaderViewportState,
} from "./StorylineReader";
import { StorylineRestoreError } from "./StorylineRestoreError";
import { StoryCreateFromSettingView } from "./StoryCreateFromSettingView";
import { StorySettingCreateView } from "./StorySettingCreateView";
import type { StorySettingCompletionStatus } from "./StorySettingCreateView";
import { StorySettingDetailView } from "./StorySettingDetailView";
import type { StorySettingDetailStatus } from "./StorySettingDetailView";
import { StorySettingEntryButton } from "./StorySettingEntryButton";
import { StorySettingListView } from "./StorySettingListView";
import type { StorySettingListStatus } from "./StorySettingListView";
import { getLatestGeneratedSegmentId } from "./storylineSegmentUtils";

type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "preparing"
  | "streaming"
  | "updatingContext"
  | "saving"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";

interface StorylineFieldErrors {
  initialStoryText?: string;
  appendInstruction?: string;
  dialogueInput?: string;
  rewriteInstruction?: string;
  settingInspiration?: string;
  settingOpening?: string;
}

type PayloadValidationResult =
  | Readonly<{
      success: true;
      payload: StoryContinuePayload;
      intent: GenerationIntent;
    }>
  | Readonly<{ success: false; fieldErrors: StorylineFieldErrors }>;

type TemporaryTextStatus = "streaming" | "updatingContext" | null;
type BackgroundGenerationTask = StoryGenerationTask;
type GenerationIntent =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "createFromSetting" }>
  | Readonly<{ type: "append" }>
  | Readonly<{ type: "rewrite"; segmentId: StorylineSegmentId }>
  | Readonly<{ type: "dialogue" }>;

interface SubmittedCreateDraft {
  readonly initialStoryText: string;
  readonly instruction: string;
}

type StoryPageMode = "recent" | "detail" | "new";

type NewStoryView =
  | Readonly<{ type: "manual" }>
  | Readonly<{ type: "settingList" }>
  | Readonly<{ type: "settingCreate" }>
  | Readonly<{ type: "settingDetail"; settingId: StorySettingId }>
  | Readonly<{ type: "createFromSetting"; settingId: StorySettingId }>;

interface StoryPageProps {
  mode: StoryPageMode;
  storylineId?: StorylineId | undefined;
}

const generationFailureMessage = "生成失败，请稍后重试";
const generationCancelledMessage = "已取消生成";
const generationCompletedMessage = "生成已完成";
const generationRefreshFailureMessage = "生成已完成，但刷新故事线失败，请重试";
const backgroundStatusFailureMessage = "后台生成状态暂时不可用，稍后自动重试";
const restoreFailureMessage = "恢复故事线失败，请稍后重试";
const settingListFailureMessage = "加载设定列表失败，请稍后重试";
const settingDetailFailureMessage = "加载设定失败，请稍后重试";
const settingCompletionFailureMessage = "补全设定失败，请稍后重试";
const settingRevisionFailureMessage = "修改设定失败，请稍后重试";
const settingSaveFailureMessage = "保存设定失败，请稍后重试";
const notFoundFailureTitle = "故事线不可用";
const bottomScrollThresholdPx = 140;
const backgroundPollIntervalMs = 2000;
const submittedCreateStorylineId = "local-create-preview";
const submittedCreateInitialSegmentId = "local-create-preview-initial";
const submittedCreateUpdatedAt = "1970-01-01T00:00:00.000Z";

export function StoryPage({ mode, storylineId }: StoryPageProps): JSX.Element {
  const navigate = useNavigate();
  const generationHandleRef = useRef<StoryRealtimeGenerationHandle | null>(
    null,
  );
  const settingCompletionHandleRef =
    useRef<StorySettingCompletionHandle | null>(null);
  const hasReceivedSettingContentRef = useRef(false);
  const hasReceivedSettingReasoningRef = useRef(false);
  const backgroundPollTimerRef = useRef<number | null>(null);
  const backgroundPollFailureNotifiedRef = useRef<boolean>(false);
  const isMountedRef = useRef(false);
  const restoreRequestIdRef = useRef(0);
  const shouldFollowScrollRef = useRef(true);

  const [status, setStatus] = useState<StorylinePageStatus>("loading");
  const [storyline, setStoryline] = useState<StorylineSnapshot | null>(null);
  const [initialStoryText, setInitialStoryText] = useState("");
  const [appendInstruction, setAppendInstruction] = useState("");
  const [submittedCreateDraft, setSubmittedCreateDraft] =
    useState<SubmittedCreateDraft | null>(null);
  const [appendTargetLength, setAppendTargetLength] =
    useState<AppendTargetLength>(() =>
      readAppendTargetLengthPreference(getCurrentStoryUserId()),
    );
  const [dialogueInput, setDialogueInput] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteTargetSegmentId, setRewriteTargetSegmentId] =
    useState<StorylineSegmentId | null>(null);
  const [composerMode, setComposerMode] =
    useState<StorylineComposerMode>("append");
  const [activeDrawerMode, setActiveDrawerMode] =
    useState<StoryActionKind | null>(null);
  const [activeGenerationIntent, setActiveGenerationIntent] =
    useState<GenerationIntent | null>(null);
  const [backgroundTask, setBackgroundTask] =
    useState<BackgroundGenerationTask | null>(null);
  const [temporaryAppendText, setTemporaryAppendText] = useState("");
  const [temporaryDialogueText, setTemporaryDialogueText] = useState("");
  const [temporaryRewrite, setTemporaryRewrite] =
    useState<RewriteDraftState | null>(null);
  const [readerViewport, setReaderViewport] =
    useState<StorylineReaderViewportState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<StorylineFieldErrors>({});
  const [restoreErrorTitle, setRestoreErrorTitle] = useState("故事线恢复失败");
  const [restoreErrorMessage, setRestoreErrorMessage] = useState(
    restoreFailureMessage,
  );
  const [generationStatusMessage, setGenerationStatusMessage] = useState("");
  const [newStoryView, setNewStoryView] = useState<NewStoryView>(() =>
    mode === "new" ? parseNewStoryViewFromCurrentLocation() : { type: "manual" },
  );
  const [storySettingListStatus, setStorySettingListStatus] =
    useState<StorySettingListStatus>("loading");
  const [storySettings, setStorySettings] = useState<
    readonly StorySettingListItem[]
  >([]);
  const [storySettingListErrorMessage, setStorySettingListErrorMessage] =
    useState(settingListFailureMessage);
  const [storySettingDetailStatus, setStorySettingDetailStatus] =
    useState<StorySettingDetailStatus>("loading");
  const [activeStorySetting, setActiveStorySetting] =
    useState<StorySetting | null>(null);
  const [storySettingDetailErrorMessage, setStorySettingDetailErrorMessage] =
    useState(settingDetailFailureMessage);
  const [settingInspiration, setSettingInspiration] = useState("");
  const [settingCompletionText, setSettingCompletionText] = useState("");
  const [settingReasoningText, setSettingReasoningText] = useState("");
  const [isSettingReasoningExpanded, setIsSettingReasoningExpanded] =
    useState(false);
  const [settingCompletionStatus, setSettingCompletionStatus] =
    useState<StorySettingCompletionStatus>("idle");
  const [settingOpening, setSettingOpening] = useState("");

  const isGenerating =
    status === "connecting" ||
    status === "preparing" ||
    status === "streaming" ||
    status === "updatingContext" ||
    status === "saving";
  const temporaryTextStatus = getTemporaryTextStatus(status);
  const latestGeneratedSegmentId =
    storyline === null ? null : getLatestGeneratedSegmentId(storyline.segments);
  const availableActions: readonly StoryActionKind[] =
    latestGeneratedSegmentId === null
      ? ["append", "dialogue"]
      : ["append", "rewrite", "dialogue"];
  const isActionFabVisible =
    storyline !== null &&
    activeDrawerMode === null &&
    (isGenerating || readerViewport?.isViewingLatestPage === true);
  const mainBottomPaddingClassName = storyline === null ? "pb-12" : "pb-28";
  const submittedCreateStoryline = useMemo<StorylineSnapshot | null>(
    () =>
      submittedCreateDraft === null
        ? null
        : buildSubmittedCreateStoryline(submittedCreateDraft),
    [submittedCreateDraft],
  );

  const clearBackgroundPoll = useCallback((): void => {
    if (backgroundPollTimerRef.current === null) {
      return;
    }

    window.clearInterval(backgroundPollTimerRef.current);
    backgroundPollTimerRef.current = null;
  }, []);

  const loadStorySettings = useCallback(async (): Promise<void> => {
    setStorySettingListStatus("loading");
    setStorySettingListErrorMessage(settingListFailureMessage);

    const result = await listStorySettings();
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "failed") {
      setStorySettings([]);
      setStorySettingListErrorMessage(result.message);
      setStorySettingListStatus("failed");
      return;
    }

    setStorySettings(result.settings);
    setStorySettingListStatus(
      result.settings.length === 0 ? "empty" : "ready",
    );
  }, [navigate]);

  const loadStorySetting = useCallback(
    async (settingId: StorySettingId): Promise<void> => {
      setStorySettingDetailStatus("loading");
      setStorySettingDetailErrorMessage(settingDetailFailureMessage);
      setActiveStorySetting(null);

      const result = await getStorySetting(settingId);
      if (!isMountedRef.current) {
        return;
      }

      if (result.status === "authRequired") {
        void navigate("/login", { replace: true });
        return;
      }

      if (result.status === "notFound" || result.status === "failed") {
        setStorySettingDetailErrorMessage(result.message);
        setStorySettingDetailStatus("failed");
        return;
      }

      setActiveStorySetting(result.setting);
      setStorySettingDetailStatus("ready");
    },
    [navigate],
  );

  const restoreStorylineSnapshot = useCallback(
    async (targetStorylineId: StorylineId): Promise<boolean> => {
      const result = await getStoryline(targetStorylineId);
      if (!isMountedRef.current) {
        return false;
      }

      if (result.status === "authRequired") {
        void navigate("/login", { replace: true });
        return false;
      }

      if (result.status === "notFound") {
        setStoryline(null);
        setRestoreErrorTitle(notFoundFailureTitle);
        setRestoreErrorMessage(result.message);
        setStatus("restoreFailed");
        return false;
      }

      if (result.status === "failed") {
        toast.error(result.message);
        return false;
      }

      setStoryline(result.storyline);
      return true;
    },
    [navigate],
  );

  const handleBackgroundTask = useCallback(
    async (
      task: BackgroundGenerationTask | null,
      targetStorylineId: StorylineId,
    ): Promise<void> => {
      if (!isMountedRef.current) {
        return;
      }

      if (task === null) {
        clearBackgroundPoll();
        setBackgroundTask(null);
        setGenerationStatusMessage("");
        setStatus("ready");
        return;
      }

      if (task.status === "running") {
        setBackgroundTask(task);
        setTemporaryAppendText("");
        setTemporaryDialogueText("");
        setTemporaryRewrite(null);
        setActiveGenerationIntent(null);
        setGenerationStatusMessage(getBackgroundPhaseMessage(task.phase));
        setStatus(getStatusFromGenerationPhase(task.phase));
        return;
      }

      clearBackgroundPoll();

      if (task.status === "completed") {
        const wasRestored = await restoreStorylineSnapshot(targetStorylineId);
        if (!isMountedRef.current) {
          return;
        }

        if (wasRestored) {
          setBackgroundTask(null);
          setGenerationStatusMessage("");
          setStatus("completed");
          toast(generationCompletedMessage);
          return;
        }

        setBackgroundTask(task);
        setGenerationStatusMessage(generationRefreshFailureMessage);
        toast.error(generationRefreshFailureMessage);
        return;
      }

      setBackgroundTask(null);
      setGenerationStatusMessage("");
      if (task.status === "failed") {
        toast.error(task.message ?? generationFailureMessage);
        setStatus("failed");
        return;
      }

      toast(generationCancelledMessage);
      setStatus("cancelled");
    },
    [clearBackgroundPoll, restoreStorylineSnapshot],
  );

  const pollBackgroundTask = useCallback(
    async (targetStorylineId: StorylineId): Promise<void> => {
      const result = await getStoryGenerationStatus(targetStorylineId);
      if (!isMountedRef.current) {
        return;
      }

      if (result.status === "authRequired") {
        clearBackgroundPoll();
        void navigate("/login", { replace: true });
        return;
      }

      if (result.status === "notFound") {
        clearBackgroundPoll();
        setStoryline(null);
        setRestoreErrorTitle(notFoundFailureTitle);
        setRestoreErrorMessage(result.message);
        setStatus("restoreFailed");
        return;
      }

      if (result.status === "failed") {
        if (!backgroundPollFailureNotifiedRef.current) {
          backgroundPollFailureNotifiedRef.current = true;
          toast.error(backgroundStatusFailureMessage);
        }
        return;
      }

      backgroundPollFailureNotifiedRef.current = false;
      await handleBackgroundTask(result.task, targetStorylineId);
    },
    [clearBackgroundPoll, handleBackgroundTask, navigate],
  );

  const restoreStoryline = useCallback(async (): Promise<void> => {
    const requestId = restoreRequestIdRef.current + 1;
    restoreRequestIdRef.current = requestId;

    clearBackgroundPoll();
    backgroundPollFailureNotifiedRef.current = false;
    generationHandleRef.current?.close();
    generationHandleRef.current = null;
    settingCompletionHandleRef.current?.close();
    settingCompletionHandleRef.current = null;
    setBackgroundTask(null);
    setStatus("loading");
    setTemporaryAppendText("");
    setTemporaryDialogueText("");
    setTemporaryRewrite(null);
    setActiveDrawerMode(null);
    setActiveGenerationIntent(null);
    setSubmittedCreateDraft(null);
    setFieldErrors({});
    setRestoreErrorTitle("故事线恢复失败");
    setRestoreErrorMessage(restoreFailureMessage);
    setGenerationStatusMessage("");

    if (mode === "new") {
      setNewStoryView(parseNewStoryViewFromCurrentLocation());
      setStoryline(null);
      setInitialStoryText("");
      setAppendInstruction("");
      setSubmittedCreateDraft(null);
      setDialogueInput("");
      setRewriteInstruction("");
      setRewriteTargetSegmentId(null);
      setComposerMode("append");
      setActiveStorySetting(null);
      setSettingInspiration("");
      setSettingCompletionText("");
      setSettingReasoningText("");
      setIsSettingReasoningExpanded(false);
      hasReceivedSettingContentRef.current = false;
      hasReceivedSettingReasoningRef.current = false;
      setSettingCompletionStatus("idle");
      setSettingOpening("");
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
    setAppendInstruction("");
    setSubmittedCreateDraft(null);
    setDialogueInput("");
    setRewriteInstruction("");
    setRewriteTargetSegmentId(null);
    setComposerMode("append");
    if (result.storyline === null) {
      setStatus("empty");
      return;
    }

    const statusResult = await getStoryGenerationStatus(result.storyline.id);
    if (!isMountedRef.current || restoreRequestIdRef.current !== requestId) {
      return;
    }

    if (statusResult.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (statusResult.status === "notFound") {
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage(statusResult.message);
      setStatus("restoreFailed");
      return;
    }

    if (statusResult.status === "failed") {
      setStatus("ready");
      toast.error(statusResult.message);
      return;
    }

    await handleBackgroundTask(statusResult.task, result.storyline.id);
  }, [clearBackgroundPoll, handleBackgroundTask, mode, navigate, storylineId]);

  useEffect(() => {
    const currentStorylineId = storyline?.id;
    if (
      backgroundTask?.status !== "running" ||
      currentStorylineId === undefined
    ) {
      clearBackgroundPoll();
      return undefined;
    }

    clearBackgroundPoll();
    backgroundPollTimerRef.current = window.setInterval(() => {
      void pollBackgroundTask(currentStorylineId);
    }, backgroundPollIntervalMs);

    return () => {
      clearBackgroundPoll();
    };
  }, [
    backgroundTask?.status,
    clearBackgroundPoll,
    pollBackgroundTask,
    storyline?.id,
  ]);

  useEffect(() => {
    isMountedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void restoreStoryline();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      isMountedRef.current = false;
      clearBackgroundPoll();
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
      settingCompletionHandleRef.current?.close();
      settingCompletionHandleRef.current = null;
    };
  }, [clearBackgroundPoll, restoreStoryline]);

  useEffect(() => {
    if (mode !== "new" || newStoryView.type !== "settingList") {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void loadStorySettings();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadStorySettings, mode, newStoryView]);

  useEffect(() => {
    if (
      mode !== "new" ||
      (newStoryView.type !== "settingDetail" &&
        newStoryView.type !== "createFromSetting")
    ) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void loadStorySetting(newStoryView.settingId);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadStorySetting, mode, newStoryView]);

  useEffect(() => {
    if (storyline !== null || !shouldFollowScrollRef.current) {
      return undefined;
    }

    const frameId = requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth",
      });
    });

    return () => cancelAnimationFrame(frameId);
  }, [status, storyline, temporaryAppendText]);

  function handleInitialStoryTextChange(value: string): void {
    setInitialStoryText(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "initialStoryText"),
    );
  }

  function handleAppendInstructionChange(value: string): void {
    setAppendInstruction(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "appendInstruction"),
    );
  }

  function handleAppendTargetLengthChange(value: AppendTargetLength): void {
    setAppendTargetLength(value);
    writeAppendTargetLengthPreference(getCurrentStoryUserId(), value);
  }

  function handleDialogueInputChange(value: string): void {
    setDialogueInput(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "dialogueInput"),
    );
  }

  function handleRewriteInstructionChange(value: string): void {
    setRewriteInstruction(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "rewriteInstruction"),
    );
  }

  function handleSettingInspirationChange(value: string): void {
    setSettingInspiration(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "settingInspiration"),
    );
  }

  function handleSettingOpeningChange(value: string): void {
    setSettingOpening(value);
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "settingOpening"),
    );
  }

  const handleReaderViewportChange = useCallback(
    (state: StorylineReaderViewportState): void => {
      setReaderViewport(state);
    },
    [],
  );

  function handleSelectStoryAction(action: StoryActionKind): void {
    if (isGenerating || storyline === null) {
      return;
    }

    if (action === "rewrite") {
      const latestGeneratedSegmentId = getLatestGeneratedSegmentId(
        storyline.segments,
      );
      if (latestGeneratedSegmentId === null) {
        return;
      }

      setRewriteTargetSegmentId(latestGeneratedSegmentId);
      setFieldErrors((previousFieldErrors) =>
        removeFieldError(previousFieldErrors, "rewriteInstruction"),
      );
    }

    setGenerationStatusMessage("");
    setActiveDrawerMode(action);
  }

  function handleOpenSettingList(): void {
    if (isGenerating || mode !== "new") {
      return;
    }

    setNewStoryView({ type: "settingList" });
    void navigate("/storylines/new", { replace: true });
  }

  function handleBackToManualCreate(): void {
    closeSettingCompletionStream();
    setNewStoryView({ type: "manual" });
    setActiveStorySetting(null);
    setSettingInspiration("");
    setSettingCompletionText("");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    setSettingCompletionStatus("idle");
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(
        removeFieldError(previousFieldErrors, "settingInspiration"),
        "settingOpening",
      ),
    );
    void navigate("/storylines/new", { replace: true });
  }

  function handleOpenSettingCreate(): void {
    closeSettingCompletionStream();
    setNewStoryView({ type: "settingCreate" });
    setSettingInspiration("");
    setSettingCompletionText("");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    setSettingCompletionStatus("idle");
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "settingInspiration"),
    );
    void navigate("/storylines/new", { replace: true });
  }

  function handleBackToSettingList(): void {
    closeSettingCompletionStream();
    setNewStoryView({ type: "settingList" });
    setActiveStorySetting(null);
    setSettingInspiration("");
    setSettingCompletionText("");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    setSettingCompletionStatus("idle");
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(
        removeFieldError(previousFieldErrors, "settingInspiration"),
        "settingOpening",
      ),
    );
    void navigate("/storylines/new", { replace: true });
  }

  function handleSelectSetting(settingId: StorySettingId): void {
    setNewStoryView({ type: "settingDetail", settingId });
    setActiveStorySetting(null);
    setStorySettingDetailStatus("loading");
  }

  function handleStartFromSetting(settingId: StorySettingId): void {
    setNewStoryView({ type: "createFromSetting", settingId });
    setSettingOpening("");
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "settingOpening"),
    );
    void navigate(
      `/storylines/new?mode=setting&settingId=${encodeURIComponent(settingId)}`,
      { replace: true },
    );
  }

  function closeSettingCompletionStream(): void {
    settingCompletionHandleRef.current?.close();
    settingCompletionHandleRef.current = null;
  }

  function handleCompleteSetting(): void {
    if (settingCompletionStatus !== "idle") {
      return;
    }

    const inspiration = settingInspiration.trim();
    if (inspiration.length === 0) {
      setFieldErrors((previousFieldErrors) => ({
        ...previousFieldErrors,
        settingInspiration: "请输入灵感",
      }));
      return;
    }

    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "settingInspiration"),
    );

    startSettingCompletion({
      mode: "complete",
      inspiration,
    });
  }

  function handleReviseSetting(revisionInstruction: string): void {
    const currentSetting = settingCompletionText.trim();
    const normalizedInstruction = revisionInstruction.trim();
    if (
      settingCompletionStatus !== "completed" ||
      currentSetting.length === 0 ||
      normalizedInstruction.length === 0
    ) {
      return;
    }

    startSettingCompletion(
      {
        mode: "revise",
        currentSetting,
        revisionInstruction: normalizedInstruction,
      },
      {
        fallbackText: currentSetting,
        failureMessage: settingRevisionFailureMessage,
      },
    );
  }

  function startSettingCompletion(
    request: CompleteStorySettingRequest,
    options?: Readonly<{
      fallbackText: string;
      failureMessage: string;
    }>,
  ): void {
    closeSettingCompletionStream();
    setSettingCompletionText("");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    setSettingCompletionStatus("streaming");

    settingCompletionHandleRef.current = startStorySettingCompletionStream(
      request,
      {
        onStarted() {
          setSettingCompletionStatus("streaming");
        },
        onReasoningChunk(delta) {
          if (!hasReceivedSettingReasoningRef.current) {
            hasReceivedSettingReasoningRef.current = true;
            setIsSettingReasoningExpanded(
              !hasReceivedSettingContentRef.current,
            );
          }
          setSettingReasoningText((previousText) => `${previousText}${delta}`);
        },
        onChunk(delta) {
          if (!hasReceivedSettingContentRef.current) {
            hasReceivedSettingContentRef.current = true;
            setIsSettingReasoningExpanded(false);
          }
          setSettingCompletionText((previousText) => `${previousText}${delta}`);
        },
        onCompleted() {
          settingCompletionHandleRef.current = null;
          setSettingCompletionStatus("completed");
        },
        onCancelled() {
          settingCompletionHandleRef.current = null;
          restoreSettingCompletionAfterFailure(options?.fallbackText);
        },
        onError(message) {
          settingCompletionHandleRef.current = null;
          restoreSettingCompletionAfterFailure(options?.fallbackText);
          toast.error(
            message.length > 0
              ? message
              : (options?.failureMessage ?? settingCompletionFailureMessage),
          );
        },
        onAuthRequired() {
          settingCompletionHandleRef.current = null;
          setSettingReasoningText("");
          setIsSettingReasoningExpanded(false);
          void navigate("/login", { replace: true });
        },
      },
    );
  }

  function restoreSettingCompletionAfterFailure(
    fallbackText: string | undefined,
  ): void {
    setSettingCompletionText(fallbackText ?? "");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    setSettingCompletionStatus(
      fallbackText === undefined ? "idle" : "completed",
    );
  }

  async function handleSaveSetting(): Promise<void> {
    const content = settingCompletionText.trim();
    if (content.length === 0 || settingCompletionStatus === "saving") {
      return;
    }

    setSettingCompletionStatus("saving");
    setSettingReasoningText("");
    setIsSettingReasoningExpanded(false);
    hasReceivedSettingContentRef.current = false;
    hasReceivedSettingReasoningRef.current = false;
    const result = await createStorySetting({ content });
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "failed") {
      setSettingCompletionText("");
      setSettingCompletionStatus("idle");
      toast.error(result.message.length > 0 ? result.message : settingSaveFailureMessage);
      return;
    }

    setSettingInspiration("");
    setSettingCompletionText("");
    setSettingCompletionStatus("idle");
    setActiveStorySetting(result.setting);
    handleStartFromSetting(result.setting.id);
  }

  function handleSubmitCreateFromSetting(): void {
    if (isGenerating) {
      return;
    }

    const setting = activeStorySetting;
    const opening = settingOpening.trim();
    if (setting === null || storySettingDetailStatus !== "ready") {
      toast.error(settingDetailFailureMessage);
      return;
    }

    if (opening.length === 0) {
      setFieldErrors((previousFieldErrors) => ({
        ...previousFieldErrors,
        settingOpening: "请输入开场",
      }));
      return;
    }

    const initialStoryText = buildCreateFromSettingInitialText({
      opening,
      settingContent: setting.content,
    });
    beginRealtimeGeneration({
      intent: { type: "createFromSetting" },
      payload: {
        mode: "createFromSetting",
        settingId: setting.id,
        opening,
      },
      submittedCreateDraft: {
        initialStoryText,
        instruction: opening,
      },
    });
  }

  function handleSubmit(): void {
    if (isGenerating) {
      handleCancel();
      return;
    }

    const validationResult = validatePayload({
      actionMode: activeDrawerMode,
      appendInstruction,
      appendTargetLength,
      composerMode,
      dialogueInput,
      initialStoryText,
      rewriteInstruction,
      rewriteTargetSegmentId,
      storyline,
    });
    if (!validationResult.success) {
      setFieldErrors(validationResult.fieldErrors);
      return;
    }

    beginRealtimeGeneration({
      intent: validationResult.intent,
      payload: validationResult.payload,
      submittedCreateDraft: getSubmittedCreateDraft(validationResult.payload),
    });
  }

  function beginRealtimeGeneration(input: {
    readonly intent: GenerationIntent;
    readonly payload: StoryContinuePayload;
    readonly submittedCreateDraft: SubmittedCreateDraft | null;
  }): void {
    const intent = input.intent;
    setSubmittedCreateDraft(input.submittedCreateDraft);
    shouldFollowScrollRef.current = intent.type !== "rewrite" && isNearBottom();
    setActiveDrawerMode(null);
    setActiveGenerationIntent(intent);
    setFieldErrors({});
    setTemporaryAppendText("");
    setTemporaryDialogueText("");
    setTemporaryRewrite(
      intent.type === "rewrite"
        ? { targetSegmentId: intent.segmentId, text: "" }
        : null,
    );
    setGenerationStatusMessage("");
    setStatus("connecting");
    generationHandleRef.current?.close();

    generationHandleRef.current = startStoryRealtimeGeneration(
      input.payload,
      {
        onStarted() {
          shouldFollowScrollRef.current =
            intent.type !== "rewrite" && isNearBottom();
          setStatus("streaming");
        },
        onChunk(delta) {
          setStatus("streaming");
          if (intent.type === "rewrite") {
            setTemporaryRewrite((previousDraft) => ({
              targetSegmentId: intent.segmentId,
              text: `${previousDraft?.text ?? ""}${delta}`,
            }));
            return;
          }

          if (intent.type === "dialogue") {
            setTemporaryDialogueText(
              (previousText) => `${previousText}${delta}`,
            );
            return;
          }

          shouldFollowScrollRef.current = isNearBottom();
          setTemporaryAppendText((previousText) => `${previousText}${delta}`);
        },
        onContextStarted() {
          shouldFollowScrollRef.current =
            intent.type !== "rewrite" && isNearBottom();
          setStatus("updatingContext");
        },
        onContextFailed(message) {
          toast.error(message);
        },
        onCompleted(event) {
          generationHandleRef.current = null;
          shouldFollowScrollRef.current =
            intent.type !== "rewrite" && isNearBottom();
          setStoryline(event.storyline);
          setTemporaryAppendText("");
          setTemporaryDialogueText("");
          setTemporaryRewrite(null);
          setActiveGenerationIntent(null);
          setGenerationStatusMessage("");
          setStatus("completed");

          if (intent.type === "create" || intent.type === "createFromSetting") {
            setInitialStoryText("");
            setAppendInstruction("");
            setSettingOpening("");
            setNewStoryView({ type: "manual" });
            setSubmittedCreateDraft(null);
            void navigate(`/storylines/${event.storyline.id}`, {
              replace: true,
            });
            return;
          }

          if (intent.type === "append") {
            setAppendInstruction("");
            return;
          }

          if (intent.type === "dialogue") {
            setDialogueInput("");
            return;
          }

          setRewriteInstruction("");
          setRewriteTargetSegmentId(null);
          setComposerMode("append");
        },
        onCancelled() {
          generationHandleRef.current = null;
          if (intent.type === "rewrite") {
            setTemporaryRewrite(null);
          } else if (intent.type === "dialogue") {
            setTemporaryDialogueText("");
          } else {
            setTemporaryAppendText("");
          }
          setActiveGenerationIntent(null);
          if (intent.type === "create") {
            setSubmittedCreateDraft(null);
            setGenerationStatusMessage(generationCancelledMessage);
          } else if (intent.type === "createFromSetting") {
            setSubmittedCreateDraft(null);
            toast(generationCancelledMessage);
          } else {
            toast(generationCancelledMessage);
          }
          setStatus("cancelled");
        },
        onError(error) {
          generationHandleRef.current = null;
          if (intent.type === "rewrite") {
            setTemporaryRewrite(null);
          } else if (intent.type === "dialogue") {
            setTemporaryDialogueText("");
          } else {
            setTemporaryAppendText("");
          }
          setActiveGenerationIntent(null);
          const message = getGenerationErrorMessage(error);
          if (intent.type === "create") {
            setSubmittedCreateDraft(null);
            setGenerationStatusMessage(message);
          } else if (intent.type === "createFromSetting") {
            setSubmittedCreateDraft(null);
            toast.error(message);
          } else {
            toast.error(message);
          }
          setStatus("failed");
        },
        onAuthRequired() {
          generationHandleRef.current = null;
          setSubmittedCreateDraft(null);
          setActiveGenerationIntent(null);
          void navigate("/login", { replace: true });
        },
      },
    );
  }

  function handleCancel(): void {
    if (generationHandleRef.current !== null) {
      generationHandleRef.current.cancel();
      return;
    }

    if (
      storyline !== null &&
      backgroundTask !== null &&
      backgroundTask.status === "running"
    ) {
      void cancelBackgroundGeneration(storyline.id);
    }
  }

  async function cancelBackgroundGeneration(
    targetStorylineId: StorylineId,
  ): Promise<void> {
    const result = await cancelStoryGeneration(targetStorylineId);
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "notFound") {
      clearBackgroundPoll();
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage(result.message);
      setStatus("restoreFailed");
      return;
    }

    if (result.status === "failed") {
      toast.error(result.message);
      return;
    }

    await handleBackgroundTask(result.task, targetStorylineId);
  }

  function handleCancelRewrite(): void {
    if (isGenerating) {
      return;
    }

    setComposerMode("append");
    setRewriteTargetSegmentId(null);
    setTemporaryRewrite(null);
    setGenerationStatusMessage("");
    setFieldErrors((previousFieldErrors) =>
      removeFieldError(previousFieldErrors, "rewriteInstruction"),
    );
  }

  function handleGoToStorylineList(): void {
    if (isGenerating) {
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
      void navigate("/storylines");
      return;
    }

    if (
      hasUnsavedDraft(
        initialStoryText,
        appendInstruction,
        rewriteInstruction,
        dialogueInput,
      )
    ) {
      const shouldLeave = window.confirm(
        "当前输入尚未提交，离开会丢失。确定返回故事列表吗？",
      );
      if (!shouldLeave) {
        return;
      }
    }

    void navigate("/storylines");
  }

  function handleOpenContextDebug(): void {
    if (storyline === null) {
      return;
    }

    if (isGenerating) {
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
      void navigate(`/storylines/${encodeURIComponent(storyline.id)}/context`);
      return;
    }

    if (
      hasUnsavedDraft(
        initialStoryText,
        appendInstruction,
        rewriteInstruction,
        dialogueInput,
      )
    ) {
      const shouldLeave = window.confirm(
        "当前输入尚未提交，离开会丢失。确定打开调试页面吗？",
      );
      if (!shouldLeave) {
        return;
      }
    }

    void navigate(`/storylines/${encodeURIComponent(storyline.id)}/context`);
  }

  function renderNewStoryView(): JSX.Element {
    switch (newStoryView.type) {
      case "settingList":
        return (
          <StorySettingListView
            errorMessage={storySettingListErrorMessage}
            onBack={handleBackToManualCreate}
            onCreate={handleOpenSettingCreate}
            onRetry={() => {
              void loadStorySettings();
            }}
            onSelect={handleSelectSetting}
            settings={storySettings}
            status={storySettingListStatus}
          />
        );
      case "settingCreate":
        return (
          <StorySettingCreateView
            completionText={settingCompletionText}
            error={fieldErrors.settingInspiration}
            inspiration={settingInspiration}
            isReasoningExpanded={isSettingReasoningExpanded}
            onBack={handleBackToSettingList}
            onComplete={handleCompleteSetting}
            onInspirationChange={handleSettingInspirationChange}
            onReasoningExpandedChange={setIsSettingReasoningExpanded}
            onRevise={handleReviseSetting}
            onSave={() => {
              void handleSaveSetting();
            }}
            reasoningText={settingReasoningText}
            status={settingCompletionStatus}
          />
        );
      case "settingDetail":
        return (
          <StorySettingDetailView
            errorMessage={storySettingDetailErrorMessage}
            onBack={handleBackToSettingList}
            onRetry={() => {
              void loadStorySetting(newStoryView.settingId);
            }}
            onStart={() => handleStartFromSetting(newStoryView.settingId)}
            setting={activeStorySetting}
            status={storySettingDetailStatus}
          />
        );
      case "createFromSetting":
        return (
          <StoryCreateFromSettingView
            errorMessage={storySettingDetailErrorMessage}
            isGenerating={isGenerating}
            onBack={handleGoToStorylineList}
            onOpeningChange={handleSettingOpeningChange}
            onRetry={() => {
              void loadStorySetting(newStoryView.settingId);
            }}
            onSubmit={handleSubmitCreateFromSetting}
            opening={settingOpening}
            openingError={fieldErrors.settingOpening}
            setting={activeStorySetting}
            status={storySettingDetailStatus}
          />
        );
      case "manual":
        return renderManualCreateView();
    }
  }

  function renderManualCreateView(): JSX.Element {
    return (
      <>
        {mode === "new" ? (
          <StorySettingEntryButton onClick={handleOpenSettingList} />
        ) : null}
        <StoryInitialInput
          disabled={isGenerating}
          error={fieldErrors.initialStoryText}
          onChange={handleInitialStoryTextChange}
          value={initialStoryText}
        />
        <div aria-hidden="true" className="h-px bg-(--border)" />
        <StorylineComposer
          disabled={isGenerating}
          error={
            composerMode === "rewrite"
              ? fieldErrors.rewriteInstruction
              : fieldErrors.appendInstruction
          }
          isGenerating={isGenerating}
          mode={composerMode}
          modeHint={composerMode === "rewrite" ? "正在重写上一段" : undefined}
          onCancelGeneration={handleCancel}
          onCancelRewrite={handleCancelRewrite}
          onChange={
            composerMode === "rewrite"
              ? handleRewriteInstructionChange
              : handleAppendInstructionChange
          }
          onSubmit={handleSubmit}
          value={composerMode === "rewrite" ? rewriteInstruction : appendInstruction}
        />
      </>
    );
  }

  const latestGeneration = storyline?.latestGeneration ?? null;
  const contextDebugStorylineId = storyline?.id ?? null;

  return (
    <main
      aria-label="StoryAgent"
      className={`min-h-svh px-4 pt-[calc(6rem+env(safe-area-inset-top))] ${mainBottomPaddingClassName} [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)] md:px-6 md:pt-[calc(6.5rem+env(safe-area-inset-top))]`}
    >
      <StoryPageHeader
        contextDebugStorylineId={contextDebugStorylineId}
        onBackToList={handleGoToStorylineList}
        onOpenContextDebug={handleOpenContextDebug}
      />
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-5">
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
                onViewportChange={handleReaderViewportChange}
                storyline={storyline}
                temporaryAppendText={temporaryAppendText}
                temporaryAppendVisible={
                  activeGenerationIntent?.type === "append"
                }
                temporaryDialogueText={temporaryDialogueText}
                temporaryDialogueVisible={
                  activeGenerationIntent?.type === "dialogue"
                }
                temporaryRewrite={temporaryRewrite}
                temporaryTextStatus={temporaryTextStatus}
              />
            ) : submittedCreateDraft !== null &&
              submittedCreateStoryline !== null ? (
              <StorylineReader
                initialInstruction={submittedCreateDraft.instruction}
                onViewportChange={handleReaderViewportChange}
                storyline={submittedCreateStoryline}
                temporaryAppendText={temporaryAppendText}
                temporaryAppendVisible={
                  activeGenerationIntent?.type === "create" ||
                  activeGenerationIntent?.type === "createFromSetting"
                }
                temporaryDialogueText=""
                temporaryDialogueVisible={false}
                temporaryRewrite={null}
                temporaryTextStatus={temporaryTextStatus}
              />
            ) : mode === "new" && newStoryView.type !== "manual" ? (
              renderNewStoryView()
            ) : (
              renderManualCreateView()
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

      {activeDrawerMode !== null ? (
        <StoryActionDrawer
          appendLengthSelector={
            activeDrawerMode === "append"
              ? {
                  value: appendTargetLength,
                  options: APPEND_TARGET_LENGTH_OPTIONS,
                  onChange: handleAppendTargetLengthChange,
                }
              : undefined
          }
          error={getDrawerError(fieldErrors, activeDrawerMode)}
          mode={activeDrawerMode}
          onChange={(value) => {
            handleDrawerValueChange(activeDrawerMode, value, {
              onAppendChange: handleAppendInstructionChange,
              onDialogueChange: handleDialogueInputChange,
              onRewriteChange: handleRewriteInstructionChange,
            });
          }}
          onClose={() => setActiveDrawerMode(null)}
          onSubmit={handleSubmit}
          value={getDrawerValue(
            {
              appendInstruction,
              dialogueInput,
              rewriteInstruction,
            },
            activeDrawerMode,
          )}
        />
      ) : null}

      <StoryActionFab
        availableActions={availableActions}
        isGenerating={isGenerating}
        isVisible={isActionFabVisible}
        onCancelGeneration={handleCancel}
        onSelectAction={handleSelectStoryAction}
      />
    </main>
  );
}

interface ValidatePayloadInput {
  actionMode: StoryActionKind | null;
  appendInstruction: string;
  appendTargetLength: AppendTargetLength;
  composerMode: StorylineComposerMode;
  dialogueInput: string;
  initialStoryText: string;
  rewriteInstruction: string;
  rewriteTargetSegmentId: StorylineSegmentId | null;
  storyline: StorylineSnapshot | null;
}

function validatePayload(input: ValidatePayloadInput): PayloadValidationResult {
  const fieldErrors: StorylineFieldErrors = {};

  if (input.storyline === null) {
    const instruction = input.appendInstruction.trim();
    const initialStoryText = input.initialStoryText.trim();
    if (instruction.length === 0) {
      fieldErrors.appendInstruction = "请输入续写指令";
    }

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
      intent: { type: "create" },
    };
  }

  const actionMode = input.actionMode ?? input.composerMode;

  if (actionMode === "rewrite") {
    const instruction = input.rewriteInstruction.trim();
    const targetSegmentId = input.rewriteTargetSegmentId;
    if (instruction.length === 0) {
      fieldErrors.rewriteInstruction = "请输入重写指令";
    }

    if (targetSegmentId === null) {
      fieldErrors.rewriteInstruction = "当前段落不可重写";
      return { success: false, fieldErrors };
    }

    if (Object.keys(fieldErrors).length > 0) {
      return { success: false, fieldErrors };
    }

    return {
      success: true,
      payload: {
        mode: "rewrite",
        storylineId: input.storyline.id,
        segmentId: targetSegmentId,
        instruction,
      },
      intent: {
        type: "rewrite",
        segmentId: targetSegmentId,
      },
    };
  }

  if (actionMode === "dialogue") {
    const dialogueInput = input.dialogueInput.trim();
    if (dialogueInput.length === 0) {
      fieldErrors.dialogueInput = "请输入互动内容";
    }

    if (Object.keys(fieldErrors).length > 0) {
      return { success: false, fieldErrors };
    }

    return {
      success: true,
      payload: {
        mode: "dialogue",
        storylineId: input.storyline.id,
        input: dialogueInput,
      },
      intent: { type: "dialogue" },
    };
  }

  const instruction = input.appendInstruction.trim();
  if (instruction.length === 0) {
    fieldErrors.appendInstruction = "请输入续写指令";
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
      targetLength: input.appendTargetLength,
    },
    intent: { type: "append" },
  };
}

function getSubmittedCreateDraft(
  payload: StoryContinuePayload,
): SubmittedCreateDraft | null {
  if (payload.mode !== "create") {
    return null;
  }

  return {
    initialStoryText: payload.initialStoryText,
    instruction: payload.instruction,
  };
}

function buildSubmittedCreateStoryline(
  draft: SubmittedCreateDraft,
): StorylineSnapshot {
  return {
    id: submittedCreateStorylineId,
    latestGeneration: null,
    segments: [
      {
        id: submittedCreateInitialSegmentId,
        text: draft.initialStoryText,
        type: "initial",
      },
    ],
    updatedAt: submittedCreateUpdatedAt,
  };
}

function parseNewStoryViewFromCurrentLocation(): NewStoryView {
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get("mode") !== "setting") {
    return { type: "manual" };
  }

  const settingId = searchParams.get("settingId")?.trim();
  if (settingId === undefined || settingId.length === 0) {
    return { type: "manual" };
  }

  return {
    type: "createFromSetting",
    settingId,
  };
}

function buildCreateFromSettingInitialText(input: {
  readonly opening: string;
  readonly settingContent: string;
}): string {
  return [
    "【设定】",
    input.settingContent.trim(),
    "",
    "【开场】",
    input.opening.trim(),
  ].join("\n");
}

function getCurrentStoryUserId(): string | null {
  return getStoredAuthSession()?.me.userId ?? null;
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
    case "updatingContext":
      return "updatingContext";
    default:
      return null;
  }
}

function getStatusFromGenerationPhase(
  phase: StoryGenerationPhase | undefined,
): StorylinePageStatus {
  switch (phase) {
    case "preparing":
      return "preparing";
    case "streaming":
      return "streaming";
    case "updatingContext":
      return "updatingContext";
    case "saving":
      return "saving";
    default:
      return "preparing";
  }
}

function getBackgroundPhaseMessage(
  phase: StoryGenerationPhase | undefined,
): string {
  switch (phase) {
    case "preparing":
      return "准备后台生成中...";
    case "streaming":
      return "正在后台生成正文...";
    case "updatingContext":
      return "正在后台更新故事上下文...";
    case "saving":
      return "正在保存后台生成结果...";
    default:
      return "后台生成进行中...";
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

function hasUnsavedDraft(
  initialStoryText: string,
  appendInstruction: string,
  rewriteInstruction: string,
  dialogueInput: string,
): boolean {
  return (
    initialStoryText.trim().length > 0 ||
    appendInstruction.trim().length > 0 ||
    rewriteInstruction.trim().length > 0 ||
    dialogueInput.trim().length > 0
  );
}

function getDrawerError(
  fieldErrors: StorylineFieldErrors,
  mode: StoryActionKind,
): string | undefined {
  switch (mode) {
    case "append":
      return fieldErrors.appendInstruction;
    case "rewrite":
      return fieldErrors.rewriteInstruction;
    case "dialogue":
      return fieldErrors.dialogueInput;
  }
}

function getDrawerValue(
  values: Readonly<{
    appendInstruction: string;
    dialogueInput: string;
    rewriteInstruction: string;
  }>,
  mode: StoryActionKind,
): string {
  switch (mode) {
    case "append":
      return values.appendInstruction;
    case "rewrite":
      return values.rewriteInstruction;
    case "dialogue":
      return values.dialogueInput;
  }
}

function handleDrawerValueChange(
  mode: StoryActionKind,
  value: string,
  handlers: Readonly<{
    onAppendChange: (value: string) => void;
    onDialogueChange: (value: string) => void;
    onRewriteChange: (value: string) => void;
  }>,
): void {
  switch (mode) {
    case "append":
      handlers.onAppendChange(value);
      return;
    case "rewrite":
      handlers.onRewriteChange(value);
      return;
    case "dialogue":
      handlers.onDialogueChange(value);
      return;
  }
}

function getGenerationErrorMessage(
  error: StoryRealtimeGenerationError,
): string {
  if (error.code === "STORY_SEGMENT_NOT_REWRITABLE") {
    return "当前段落不可重写";
  }

  return error.message.length > 0 ? error.message : generationFailureMessage;
}

interface StoryPageHeaderProps {
  contextDebugStorylineId: StorylineId | null;
  onBackToList: () => void;
  onOpenContextDebug: () => void;
}

function StoryPageHeader({
  contextDebugStorylineId,
  onBackToList,
  onOpenContextDebug,
}: StoryPageHeaderProps): JSX.Element {
  return (
    <header className="fixed inset-x-0 top-0 z-10 border-b border-[var(--border)] bg-[var(--panel-bg)] px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 shadow-[0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur md:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold text-[var(--accent)]">
            StoryAgent
          </p>
          <h1 className="mt-0.5 mb-0 truncate text-lg font-bold text-[var(--text-h)] md:text-xl">
            故事工作台
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {contextDebugStorylineId !== null ? (
            <button
              className="min-h-10 rounded-full border border-(--border) bg-transparent px-3 py-2 text-sm font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
              onClick={onOpenContextDebug}
              type="button"
            >
              调试
            </button>
          ) : null}
          <button
            className="min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h) transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-(--accent-border)"
            onClick={onBackToList}
            type="button"
          >
            返回列表
          </button>
        </div>
      </div>
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

interface LatestGenerationMetadataProps {
  metadata: StorylineGenerationMetadata;
}

function LatestGenerationMetadata({
  metadata,
}: LatestGenerationMetadataProps): JSX.Element {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3 text-xs leading-5 text-[var(--text)]">
      <p className="m-0">
        模型：{metadata.model} / 耗时：{metadata.elapsedMs}ms / Token：
        {metadata.usage.totalTokens}
      </p>
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
      className={`m-0 rounded-2xl px-4 py-3 text-sm ${
        isError
          ? "bg-[var(--danger-bg)] text-[var(--danger)]"
          : "border border-(--border) bg-(--panel-bg) text-(--text)"
      }`}
      role={isError ? "alert" : "status"}
    >
      {message}
    </p>
  );
}
