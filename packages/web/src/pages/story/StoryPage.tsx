import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type {
  CompleteStorySettingRequest,
  StoryContinuePayload,
  StoryGenerationRecoveryResponse,
  StoryGenerationPhase,
  StoryGenerationStreamSnapshot,
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
  StoryRealtimeGenerationCallbacks,
  StoryRealtimeGenerationError,
  StoryRealtimeGenerationHandle,
} from "../../story/storyRealtimeApi";
import {
  startStoryChapterChat,
  type StoryChapterChatHandle,
} from "../../story/storyChatApi";
import { getStoredAuthSession } from "../../auth/authApi";
import {
  resumeStoryRealtimeGeneration,
  startStoryRealtimeGeneration,
} from "../../story/storyRealtimeApi";
import {
  cancelStoryGeneration,
  copyStoryline,
  getRecentStoryline,
  getStoryGenerationRecovery,
  getStoryGenerationStatus,
  getStoryline,
  type StorylineWindowQuery,
} from "../../story/storylineApi";
import {
  clearStoryReasoningHandoff,
  readStoryReasoningHandoff,
  setStoryReasoningHandoff,
} from "../../story/storyReasoningHandoff";
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
import { StoryChatDrawer } from "./StoryChatDrawer";
import { StoryChatFloatingStatus } from "./StoryChatFloatingStatus";
import { StoryPageHeader } from "./StoryPageHeader";
import { StorylineCopyDialog } from "./StorylineCopyDialog";
import type { StorylineCopyDialogSubmitValue } from "./StorylineCopyDialog";
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
import { ReasoningPanel } from "./ReasoningPanel";
import { StorylineRestoreError } from "./StorylineRestoreError";
import { StoryCreateFromSettingView } from "./StoryCreateFromSettingView";
import { StorySettingCreateView } from "./StorySettingCreateView";
import type { StorySettingCompletionStatus } from "./StorySettingCreateView";
import { StorySettingDetailView } from "./StorySettingDetailView";
import type { StorySettingDetailStatus } from "./StorySettingDetailView";
import { StorySettingEntryButton } from "./StorySettingEntryButton";
import { StorySettingListView } from "./StorySettingListView";
import type { StorySettingListStatus } from "./StorySettingListView";
import {
  appendStoryChat,
  hasStoryChatDrafts,
  updateStoryChat,
  type ActiveStoryChat,
  type StoryChatDraftsByChapter,
  type StoryChatsByChapter,
} from "./storyChatTypes";
import {
  findStorylineChapter,
  getMissingChapterPages,
  mergeStorylineWindow,
  STORYLINE_CHAPTER_CACHE_RADIUS,
  trimStorylineWindow,
} from "./storylineChapterCache";

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
type ChapterLoadStatus = "idle" | "loading" | "failed";
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
const generationReconnectingMessage = "连接中断，正在恢复生成...";
const generationPersistedRefreshMessage = "生成结果已保存，正在刷新正文...";
const restoreFailureMessage = "恢复故事线失败，请稍后重试";
const chapterLoadFailureMessage = "加载章节失败，请稍后重试";
const settingListFailureMessage = "加载设定列表失败，请稍后重试";
const settingDetailFailureMessage = "加载设定失败，请稍后重试";
const settingCompletionFailureMessage = "补全设定失败，请稍后重试";
const settingRevisionFailureMessage = "修改设定失败，请稍后重试";
const settingSaveFailureMessage = "保存设定失败，请稍后重试";
const notFoundFailureTitle = "故事线不可用";
const backgroundPollIntervalMs = 2000;
const submittedCreateStorylineId = "local-create-preview";
const submittedCreateInitialSegmentId = "local-create-preview-initial";
const submittedCreateUpdatedAt = "1970-01-01T00:00:00.000Z";

export function StoryPage({ mode, storylineId }: StoryPageProps): JSX.Element {
  const navigate = useNavigate();
  const generationHandleRef = useRef<StoryRealtimeGenerationHandle | null>(
    null,
  );
  const chatHandleRef = useRef<StoryChapterChatHandle | null>(null);
  const hasReceivedStoryContentRef = useRef(false);
  const hasReceivedStoryReasoningRef = useRef(false);
  const settingCompletionHandleRef =
    useRef<StorySettingCompletionHandle | null>(null);
  const hasReceivedSettingContentRef = useRef(false);
  const hasReceivedSettingReasoningRef = useRef(false);
  const backgroundPollTimerRef = useRef<number | null>(null);
  const backgroundPollFailureNotifiedRef = useRef<boolean>(false);
  const contentScrollRef = useRef<HTMLElement | null>(null);
  const isMountedRef = useRef(false);
  const previousReaderPageIndexRef = useRef<number | null>(null);
  const readerPageIndexRef = useRef<number | null>(null);
  const restoreRequestIdRef = useRef(0);
  const chapterRequestIdRef = useRef(0);
  const chapterPrefetchRequestIdRef = useRef(0);
  const persistedRefreshRequestIdRef = useRef(0);

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
  const [chatDraftsByChapter, setChatDraftsByChapter] =
    useState<StoryChatDraftsByChapter>({});
  const [chatsByChapter, setChatsByChapter] =
    useState<StoryChatsByChapter>({});
  const [chatDrawerChapterNumber, setChatDrawerChapterNumber] = useState<
    number | null
  >(null);
  const [chatDrawerError, setChatDrawerError] = useState<string | undefined>();
  const [isChatSubmitting, setIsChatSubmitting] = useState(false);
  const [activeStoryChat, setActiveStoryChat] =
    useState<ActiveStoryChat | null>(null);
  const [isCopyDialogOpen, setIsCopyDialogOpen] = useState(false);
  const [isCopySubmitting, setIsCopySubmitting] = useState(false);
  const [copyError, setCopyError] = useState<string | undefined>();
  const [activeGenerationIntent, setActiveGenerationIntent] =
    useState<GenerationIntent | null>(null);
  const [backgroundTask, setBackgroundTask] =
    useState<BackgroundGenerationTask | null>(null);
  const [temporaryAppendText, setTemporaryAppendText] = useState("");
  const [temporaryDialogueText, setTemporaryDialogueText] = useState("");
  const [temporaryRewrite, setTemporaryRewrite] =
    useState<RewriteDraftState | null>(null);
  const [storyReasoningText, setStoryReasoningText] = useState(() =>
    mode === "detail" && storylineId !== undefined
      ? readStoryReasoningHandoff(storylineId)
      : "",
  );
  const storyReasoningTextRef = useRef(storyReasoningText);
  const [isStoryReasoningExpanded, setIsStoryReasoningExpanded] =
    useState(false);
  const [readerPageIndex, setReaderPageIndex] = useState<number | null>(null);
  const [readerViewport, setReaderViewport] =
    useState<StorylineReaderViewportState | null>(null);
  const [chapterLoadStatus, setChapterLoadStatus] =
    useState<ChapterLoadStatus>("idle");
  const [chapterLoadErrorMessage, setChapterLoadErrorMessage] = useState(
    chapterLoadFailureMessage,
  );
  const [chapterReturnPageIndex, setChapterReturnPageIndex] = useState<
    number | null
  >(null);
  const [fieldErrors, setFieldErrors] = useState<StorylineFieldErrors>({});
  const [restoreErrorTitle, setRestoreErrorTitle] = useState("故事线恢复失败");
  const [restoreErrorMessage, setRestoreErrorMessage] = useState(
    restoreFailureMessage,
  );
  const [generationStatusMessage, setGenerationStatusMessage] = useState("");
  const [newStoryView, setNewStoryView] = useState<NewStoryView>(() =>
    mode === "new"
      ? parseNewStoryViewFromCurrentLocation()
      : { type: "manual" },
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
  const isChatBusy = isChatSubmitting || activeStoryChat !== null;
  const temporaryTextStatus = getTemporaryTextStatus(status);
  const latestGeneratedSegmentId =
    storyline?.latestGeneration?.segmentId ?? null;
  const availableActions: readonly StoryActionKind[] =
    latestGeneratedSegmentId === null
      ? ["append", "dialogue"]
      : ["append", "rewrite", "dialogue"];
  const isActionFabVisible =
    storyline !== null &&
    activeDrawerMode === null &&
    chatDrawerChapterNumber === null &&
    !isCopyDialogOpen &&
    !isChatBusy &&
    chapterLoadStatus === "idle" &&
    (isGenerating || readerViewport?.isViewingLatestPage === true);
  const contentBottomPaddingClassName =
    storyline === null
      ? "pb-[calc(3rem+env(safe-area-inset-bottom))]"
      : "pb-[calc(7rem+env(safe-area-inset-bottom))]";
  const submittedCreateStoryline = useMemo<StorylineSnapshot | null>(
    () =>
      submittedCreateDraft === null
        ? null
        : buildSubmittedCreateStoryline(submittedCreateDraft),
    [submittedCreateDraft],
  );
  const isStoryReaderVisible =
    status !== "loading" &&
    status !== "restoreFailed" &&
    (storyline !== null ||
      (submittedCreateDraft !== null && submittedCreateStoryline !== null));
  const isPaginationBarVisible =
    isStoryReaderVisible &&
    readerViewport !== null &&
    readerViewport.pageCount > 0;
  const loadedChapterPageKey =
    storyline?.chapters.map((chapter) => chapter.pageNumber).join(",") ?? "";

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
    setStorySettingListStatus(result.settings.length === 0 ? "empty" : "ready");
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

  const applyLoadedStorylineWindow = useCallback(
    (
      incomingStoryline: StorylineSnapshot,
      preferredPage: number | "latest",
    ): void => {
      const pageNumber =
        preferredPage === "latest"
          ? incomingStoryline.anchorPage
          : clampReaderPage(preferredPage, incomingStoryline.chapterCount);
      const pageIndex = pageNumber - 1;

      readerPageIndexRef.current = pageIndex;
      setReaderPageIndex(pageIndex);
      setReaderViewport(
        buildReaderViewport(pageIndex, incomingStoryline.chapterCount),
      );
      setStoryline((currentStoryline) =>
        mergeStorylineWindow(currentStoryline, incomingStoryline, pageNumber),
      );
      setChapterLoadStatus("idle");
      setChapterLoadErrorMessage(chapterLoadFailureMessage);
      setChapterReturnPageIndex(null);
      replaceStorylinePageInUrl(pageNumber, incomingStoryline.chapterCount);
    },
    [],
  );

  const restoreStorylineSnapshot = useCallback(
    async (
      targetStorylineId: StorylineId,
      options: Readonly<{ notifyFailure?: boolean }> = {},
    ): Promise<boolean> => {
      const currentPage =
        readerPageIndexRef.current === null
          ? "latest"
          : readerPageIndexRef.current + 1;
      const result = await getStoryline(
        targetStorylineId,
        buildStorylineWindowQuery(currentPage),
      );
      if (!isMountedRef.current) {
        return false;
      }

      if (result.status === "authRequired") {
        persistedRefreshRequestIdRef.current += 1;
        void navigate("/login", { replace: true });
        return false;
      }

      if (result.status === "notFound") {
        persistedRefreshRequestIdRef.current += 1;
        setStoryline(null);
        setRestoreErrorTitle(notFoundFailureTitle);
        setRestoreErrorMessage(result.message);
        setStatus("restoreFailed");
        return false;
      }

      if (result.status === "failed") {
        if (options.notifyFailure !== false) {
          toast.error(result.message);
        }
        return false;
      }

      applyLoadedStorylineWindow(result.storyline, currentPage);
      return true;
    },
    [applyLoadedStorylineWindow, navigate],
  );

  const applyGenerationSnapshot = useCallback(
    (
      intent: Exclude<
        GenerationIntent,
        { type: "create" | "createFromSetting" }
      >,
      snapshot: StoryGenerationStreamSnapshot,
    ): void => {
      storyReasoningTextRef.current = snapshot.reasoningText;
      hasReceivedStoryReasoningRef.current = snapshot.reasoningText.length > 0;
      hasReceivedStoryContentRef.current = snapshot.text.length > 0;
      setStoryReasoningText(snapshot.reasoningText);
      setIsStoryReasoningExpanded(
        snapshot.reasoningText.length > 0 && snapshot.text.length === 0,
      );
      setActiveGenerationIntent(intent);
      setTemporaryAppendText(intent.type === "append" ? snapshot.text : "");
      setTemporaryDialogueText(intent.type === "dialogue" ? snapshot.text : "");
      setTemporaryRewrite(
        intent.type === "rewrite"
          ? { targetSegmentId: intent.segmentId, text: snapshot.text }
          : null,
      );
    },
    [],
  );

  const appendStoryReasoning = useCallback((delta: string): void => {
    if (!hasReceivedStoryReasoningRef.current) {
      hasReceivedStoryReasoningRef.current = true;
      setIsStoryReasoningExpanded(!hasReceivedStoryContentRef.current);
    }
    storyReasoningTextRef.current += delta;
    setStoryReasoningText(storyReasoningTextRef.current);
  }, []);

  const appendStoryContent = useCallback(
    (
      intent: Exclude<
        GenerationIntent,
        { type: "create" | "createFromSetting" }
      >,
      delta: string,
    ): void => {
      setStatus("streaming");
      if (!hasReceivedStoryContentRef.current) {
        hasReceivedStoryContentRef.current = true;
        setIsStoryReasoningExpanded(false);
      }
      if (intent.type === "rewrite") {
        setTemporaryRewrite((previousDraft) => ({
          targetSegmentId: intent.segmentId,
          text: `${previousDraft?.text ?? ""}${delta}`,
        }));
        return;
      }

      if (intent.type === "dialogue") {
        setTemporaryDialogueText((previousText) => `${previousText}${delta}`);
        return;
      }

      setTemporaryAppendText((previousText) => `${previousText}${delta}`);
    },
    [],
  );

  const clearStoryReasoningState = useCallback((): void => {
    storyReasoningTextRef.current = "";
    hasReceivedStoryContentRef.current = false;
    hasReceivedStoryReasoningRef.current = false;
    setStoryReasoningText("");
    setIsStoryReasoningExpanded(false);
  }, []);

  const applyCompletedExistingStoryline = useCallback(
    (completedStoryline: StorylineSnapshot): void => {
      const currentPageNumber = clampReaderPage(
        (readerPageIndexRef.current ?? completedStoryline.anchorPage - 1) + 1,
        completedStoryline.chapterCount,
      );
      const currentPageIndex = currentPageNumber - 1;
      readerPageIndexRef.current = currentPageIndex;
      setReaderPageIndex(currentPageIndex);
      setReaderViewport(
        buildReaderViewport(currentPageIndex, completedStoryline.chapterCount),
      );
      setStoryline((currentStoryline) =>
        mergeStorylineWindow(
          currentStoryline,
          completedStoryline,
          currentPageNumber,
        ),
      );
      replaceStorylinePageInUrl(
        currentPageNumber,
        completedStoryline.chapterCount,
      );
    },
    [],
  );

  const refreshPersistedStoryline = useCallback(
    async (
      targetStorylineId: StorylineId,
      generatedSegmentId: StorylineSegmentId,
    ): Promise<void> => {
      const refreshRequestId = persistedRefreshRequestIdRef.current + 1;
      persistedRefreshRequestIdRef.current = refreshRequestId;
      let retryDelayMs = 500;
      setGenerationStatusMessage(generationPersistedRefreshMessage);

      while (
        isMountedRef.current &&
        persistedRefreshRequestIdRef.current === refreshRequestId
      ) {
        const wasRestored = await restoreStorylineSnapshot(targetStorylineId, {
          notifyFailure: false,
        });
        if (
          !isMountedRef.current ||
          persistedRefreshRequestIdRef.current !== refreshRequestId
        ) {
          return;
        }

        if (wasRestored) {
          setTemporaryAppendText("");
          setTemporaryDialogueText("");
          setTemporaryRewrite(null);
          setActiveGenerationIntent(null);
          setGenerationStatusMessage(
            `生成结果已保存，正在完成后台处理（段落 ${generatedSegmentId}）...`,
          );
          return;
        }

        await waitForRetry(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }
    },
    [restoreStorylineSnapshot],
  );

  const resumeRecoveredGeneration = useCallback(
    (
      recovery: StoryGenerationRecoveryResponse,
      targetStorylineId: StorylineId,
      intent: Exclude<
        GenerationIntent,
        { type: "create" | "createFromSetting" }
      > | null,
    ): void => {
      const task = recovery.task;
      if (task?.status !== "running") {
        return;
      }

      const callbacks: StoryRealtimeGenerationCallbacks = {
        onStarted() {
          setStatus("streaming");
        },
        onSnapshot(snapshot) {
          if (intent !== null) {
            applyGenerationSnapshot(intent, snapshot);
          }
        },
        onReasoning(delta) {
          appendStoryReasoning(delta);
        },
        onChunk(delta) {
          if (intent !== null) {
            appendStoryContent(intent, delta);
          }
        },
        onPersisted(event) {
          void refreshPersistedStoryline(
            targetStorylineId,
            event.generatedSegmentId,
          );
        },
        onContextStarted() {
          setStatus("updatingContext");
          setGenerationStatusMessage(
            getBackgroundPhaseMessage("updatingContext"),
          );
        },
        onContextFailed(message) {
          toast.error(message);
        },
        onCompleted(event) {
          generationHandleRef.current = null;
          persistedRefreshRequestIdRef.current += 1;
          setTemporaryAppendText("");
          setTemporaryDialogueText("");
          setTemporaryRewrite(null);
          setActiveGenerationIntent(null);
          setBackgroundTask(null);
          setGenerationStatusMessage("");
          setStatus("completed");
          applyCompletedExistingStoryline(event.storyline);
          toast(generationCompletedMessage);
        },
        onCancelled() {
          generationHandleRef.current = null;
          persistedRefreshRequestIdRef.current += 1;
          clearStoryReasoningState();
          setTemporaryAppendText("");
          setTemporaryDialogueText("");
          setTemporaryRewrite(null);
          setActiveGenerationIntent(null);
          setBackgroundTask(null);
          setGenerationStatusMessage("");
          setStatus("cancelled");
          toast(generationCancelledMessage);
        },
        onReconnecting() {
          setGenerationStatusMessage(generationReconnectingMessage);
        },
        onError(error) {
          generationHandleRef.current = null;
          persistedRefreshRequestIdRef.current += 1;
          clearStoryReasoningState();
          setTemporaryAppendText("");
          setTemporaryDialogueText("");
          setTemporaryRewrite(null);
          setActiveGenerationIntent(null);
          setBackgroundTask(null);
          setGenerationStatusMessage("");
          setStatus("failed");
          toast.error(getGenerationErrorMessage(error));
        },
        onAuthRequired() {
          generationHandleRef.current = null;
          persistedRefreshRequestIdRef.current += 1;
          clearStoryReasoningState();
          setActiveGenerationIntent(null);
          void navigate("/login", { replace: true });
        },
      };

      generationHandleRef.current?.close();
      generationHandleRef.current = resumeStoryRealtimeGeneration(
        {
          requestId: task.requestId,
          storylineId: targetStorylineId,
        },
        callbacks,
      );
    },
    [
      appendStoryContent,
      appendStoryReasoning,
      applyCompletedExistingStoryline,
      applyGenerationSnapshot,
      clearStoryReasoningState,
      navigate,
      refreshPersistedStoryline,
    ],
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
        setGenerationStatusMessage(getBackgroundPhaseMessage(task.phase));
        setStatus(getStatusFromGenerationPhase(task.phase));
        return;
      }

      clearBackgroundPoll();
      persistedRefreshRequestIdRef.current += 1;
      generationHandleRef.current?.close();
      generationHandleRef.current = null;

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
    persistedRefreshRequestIdRef.current += 1;
    generationHandleRef.current?.close();
    generationHandleRef.current = null;
    chatHandleRef.current?.close();
    chatHandleRef.current = null;
    settingCompletionHandleRef.current?.close();
    settingCompletionHandleRef.current = null;
    previousReaderPageIndexRef.current = null;
    readerPageIndexRef.current = null;
    chapterRequestIdRef.current += 1;
    chapterPrefetchRequestIdRef.current += 1;
    setBackgroundTask(null);
    setReaderPageIndex(null);
    setReaderViewport(null);
    setChapterLoadStatus("idle");
    setChapterLoadErrorMessage(chapterLoadFailureMessage);
    setChapterReturnPageIndex(null);
    setStatus("loading");
    setTemporaryAppendText("");
    setTemporaryDialogueText("");
    setTemporaryRewrite(null);
    setActiveDrawerMode(null);
    setChatDraftsByChapter({});
    setChatsByChapter({});
    setChatDrawerChapterNumber(null);
    setChatDrawerError(undefined);
    setIsChatSubmitting(false);
    setActiveStoryChat(null);
    setIsCopyDialogOpen(false);
    setIsCopySubmitting(false);
    setCopyError(undefined);
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

    const requestedPage = readStorylinePageFromCurrentLocation();
    const windowQuery = buildStorylineWindowQuery(requestedPage);
    const result =
      mode === "detail" && storylineId !== undefined
        ? await getStoryline(storylineId, windowQuery)
        : await getRecentStoryline(windowQuery);
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

    setInitialStoryText("");
    setAppendInstruction("");
    setSubmittedCreateDraft(null);
    setDialogueInput("");
    setRewriteInstruction("");
    setRewriteTargetSegmentId(null);
    setComposerMode("append");
    if (result.storyline === null) {
      setStoryline(null);
      setStatus("empty");
      return;
    }

    applyLoadedStorylineWindow(result.storyline, requestedPage);
    let recoveryResult = await getStoryGenerationRecovery(
      result.storyline.id,
    );
    let recoveryRetryDelayMs = 500;
    while (
      recoveryResult.status === "failed" &&
      isMountedRef.current &&
      restoreRequestIdRef.current === requestId
    ) {
      setStatus("preparing");
      setGenerationStatusMessage(generationReconnectingMessage);
      await waitForRetry(recoveryRetryDelayMs);
      if (!isMountedRef.current || restoreRequestIdRef.current !== requestId) {
        return;
      }
      recoveryResult = await getStoryGenerationRecovery(result.storyline.id);
      recoveryRetryDelayMs = Math.min(recoveryRetryDelayMs * 2, 5_000);
    }
    if (!isMountedRef.current || restoreRequestIdRef.current !== requestId) {
      return;
    }

    if (recoveryResult.status === "authRequired") {
      void navigate("/login", { replace: true });
      return;
    }

    if (recoveryResult.status === "notFound") {
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage(recoveryResult.message);
      setStatus("restoreFailed");
      return;
    }

    if (recoveryResult.status === "failed") {
      return;
    }

    const recovery = recoveryResult.recovery;
    const recoveryTask = recovery.task;
    if (recoveryTask?.status === "running") {
      setBackgroundTask(recoveryTask);
      setGenerationStatusMessage(getBackgroundPhaseMessage(recoveryTask.phase));
      setStatus(getStatusFromGenerationPhase(recoveryTask.phase));

      if (
        recovery.outputPersisted &&
        recoveryTask.generatedSegmentId !== undefined
      ) {
        void refreshPersistedStoryline(
          result.storyline.id,
          recoveryTask.generatedSegmentId,
        );
        resumeRecoveredGeneration(recovery, result.storyline.id, null);
        return;
      }

      const recoveryIntent = getRecoveryIntent(recovery);
      if (recovery.snapshot === null || recoveryIntent === null) {
        setBackgroundTask(null);
        setStatus("failed");
        toast.error(generationFailureMessage);
        return;
      }

      applyGenerationSnapshot(recoveryIntent, recovery.snapshot);
      if (recoveryIntent.type === "append") {
        const temporaryPageIndex = result.storyline.chapterCount;
        readerPageIndexRef.current = temporaryPageIndex;
        setReaderPageIndex(temporaryPageIndex);
        setReaderViewport(
          buildReaderViewport(
            temporaryPageIndex,
            result.storyline.chapterCount + 1,
          ),
        );
      }
      resumeRecoveredGeneration(recovery, result.storyline.id, recoveryIntent);
      return;
    }

    await handleBackgroundTask(recoveryTask, result.storyline.id);
  }, [
    applyGenerationSnapshot,
    applyLoadedStorylineWindow,
    clearBackgroundPoll,
    handleBackgroundTask,
    mode,
    navigate,
    refreshPersistedStoryline,
    resumeRecoveredGeneration,
    storylineId,
  ]);

  useEffect(() => {
    if (mode === "detail" && storylineId !== undefined) {
      clearStoryReasoningHandoff(storylineId);
    }
  }, [mode, storylineId]);

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
    if (storyline === null || readerPageIndex === null) {
      return;
    }

    const pageCount =
      storyline.chapterCount +
      (activeGenerationIntent?.type === "append" ? 1 : 0);
    replaceStorylinePageInUrl(
      clampReaderPage(readerPageIndex + 1, pageCount),
      pageCount,
    );
  }, [activeGenerationIntent?.type, readerPageIndex, storyline]);

  useEffect(() => {
    if (
      storyline === null ||
      readerPageIndex === null ||
      chapterLoadStatus !== "idle" ||
      (activeGenerationIntent?.type === "append" &&
        readerPageIndex === storyline.chapterCount)
    ) {
      return undefined;
    }

    const currentPageNumber = readerPageIndex + 1;
    const missingPages = getMissingChapterPages(storyline, currentPageNumber);
    const firstMissingPage = missingPages[0];
    if (firstMissingPage === undefined) {
      return undefined;
    }

    let lastMissingPage = firstMissingPage;
    for (const pageNumber of missingPages.slice(1)) {
      if (
        pageNumber !== lastMissingPage + 1 ||
        pageNumber - firstMissingPage > STORYLINE_CHAPTER_CACHE_RADIUS
      ) {
        break;
      }
      lastMissingPage = pageNumber;
    }

    const requestId = chapterPrefetchRequestIdRef.current + 1;
    chapterPrefetchRequestIdRef.current = requestId;
    void getStoryline(storyline.id, {
      anchorPage: firstMissingPage,
      before: 0,
      after: lastMissingPage - firstMissingPage,
    }).then((result) => {
      if (
        !isMountedRef.current ||
        chapterPrefetchRequestIdRef.current !== requestId
      ) {
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
        return;
      }

      const latestPageIndex = readerPageIndexRef.current;
      if (latestPageIndex === null) {
        return;
      }

      const latestPageNumber = clampReaderPage(
        latestPageIndex + 1,
        result.storyline.chapterCount,
      );
      setStoryline((currentStoryline) =>
        mergeStorylineWindow(
          currentStoryline,
          result.storyline,
          latestPageNumber,
        ),
      );
      if (latestPageNumber - 1 !== latestPageIndex) {
        readerPageIndexRef.current = latestPageNumber - 1;
        setReaderPageIndex(latestPageNumber - 1);
      }
      setReaderViewport(
        buildReaderViewport(
          latestPageNumber - 1,
          result.storyline.chapterCount,
        ),
      );
      replaceStorylinePageInUrl(
        latestPageNumber,
        result.storyline.chapterCount,
      );
    });

    return undefined;
  }, [
    activeGenerationIntent?.type,
    chapterLoadStatus,
    loadedChapterPageKey,
    navigate,
    readerPageIndex,
    storyline,
  ]);

  useEffect(() => {
    isMountedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void restoreStoryline();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      isMountedRef.current = false;
      persistedRefreshRequestIdRef.current += 1;
      clearBackgroundPoll();
      generationHandleRef.current?.close();
      generationHandleRef.current = null;
      chatHandleRef.current?.close();
      chatHandleRef.current = null;
      settingCompletionHandleRef.current?.close();
      settingCompletionHandleRef.current = null;
    };
  }, [clearBackgroundPoll, restoreStoryline]);

  useEffect(() => {
    if (activeStoryChat === null && !isChatSubmitting) {
      return undefined;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activeStoryChat, isChatSubmitting]);

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

  function handleOpenStoryChat(): void {
    const currentPageIndex = readerPageIndexRef.current;
    if (
      storyline === null ||
      currentPageIndex === null ||
      isGenerating ||
      isCopySubmitting ||
      isChatBusy ||
      chatDrawerChapterNumber !== null ||
      chapterLoadStatus !== "idle"
    ) {
      return;
    }

    const chapterNumber = currentPageIndex + 1;
    if (
      chapterNumber > storyline.chapterCount ||
      findStorylineChapter(storyline, chapterNumber) === undefined
    ) {
      return;
    }

    setChatDrawerError(undefined);
    setChatDrawerChapterNumber(chapterNumber);
  }

  function handleChatDraftChange(value: string): void {
    if (chatDrawerChapterNumber === null) {
      return;
    }

    setChatDraftsByChapter((previousDrafts) => ({
      ...previousDrafts,
      [chatDrawerChapterNumber]: value,
    }));
    setChatDrawerError(undefined);
  }

  function handleCloseChatDrawer(): void {
    if (isChatSubmitting) {
      return;
    }

    setChatDrawerChapterNumber(null);
    setChatDrawerError(undefined);
  }

  function handleSubmitStoryChat(): void {
    const chapterNumber = chatDrawerChapterNumber;
    if (
      storyline === null ||
      chapterNumber === null ||
      isGenerating ||
      isCopySubmitting ||
      activeStoryChat !== null ||
      chatHandleRef.current !== null
    ) {
      return;
    }

    const topic = (chatDraftsByChapter[chapterNumber] ?? "").trim();
    if (topic.length === 0) {
      setChatDrawerError("请输入想聊的话题");
      return;
    }
    if (
      chapterNumber > storyline.chapterCount ||
      findStorylineChapter(storyline, chapterNumber) === undefined
    ) {
      setChatDrawerError("当前章节不可用，请刷新后重试");
      return;
    }

    const chatId = crypto.randomUUID();
    let hasStarted = false;
    let didSettleSynchronously = false;
    setIsChatSubmitting(true);
    setChatDrawerError(undefined);

    const handle = startStoryChapterChat(
      storyline.id,
      { chapterNumber, topic },
      {
        onStarted() {
          if (!isMountedRef.current) {
            return;
          }

          hasStarted = true;
          setChatsByChapter((previousChats) =>
            appendStoryChat(previousChats, {
              id: chatId,
              chapterNumber,
              topic,
              reasoningText: "",
              answerText: "",
              status: "connecting",
              isExpanded: true,
              isReasoningExpanded: true,
            }),
          );
          setActiveStoryChat({ chatId, chapterNumber });
          setChatDraftsByChapter((previousDrafts) => {
            const nextDrafts = { ...previousDrafts };
            delete nextDrafts[chapterNumber];
            return nextDrafts;
          });
          setChatDrawerChapterNumber(null);
          setChatDrawerError(undefined);
          setIsChatSubmitting(false);
        },
        onReasoningChunk(delta) {
          if (!isMountedRef.current) {
            return;
          }

          setChatsByChapter((previousChats) =>
            updateStoryChat(
              previousChats,
              chapterNumber,
              chatId,
              (entry) => ({
                ...entry,
                reasoningText: `${entry.reasoningText}${delta}`,
                status:
                  entry.answerText.length > 0 ? "answering" : "thinking",
              }),
            ),
          );
        },
        onAnswerChunk(delta) {
          if (!isMountedRef.current) {
            return;
          }

          setChatsByChapter((previousChats) =>
            updateStoryChat(
              previousChats,
              chapterNumber,
              chatId,
              (entry) => ({
                ...entry,
                answerText: `${entry.answerText}${delta}`,
                status: "answering",
              }),
            ),
          );
        },
        onCompleted() {
          didSettleSynchronously = true;
          chatHandleRef.current = null;
          if (!isMountedRef.current) {
            return;
          }

          setChatsByChapter((previousChats) =>
            updateStoryChat(
              previousChats,
              chapterNumber,
              chatId,
              (entry) => ({
                ...entry,
                status: "completed",
              }),
            ),
          );
          setActiveStoryChat((currentChat) =>
            currentChat?.chatId === chatId ? null : currentChat,
          );
        },
        onCancelled() {
          didSettleSynchronously = true;
          chatHandleRef.current = null;
          if (!isMountedRef.current) {
            return;
          }

          if (hasStarted) {
            setChatsByChapter((previousChats) =>
              updateStoryChat(
                previousChats,
                chapterNumber,
                chatId,
                (entry) => ({
                  ...entry,
                  status: "cancelled",
                }),
              ),
            );
            setActiveStoryChat((currentChat) =>
              currentChat?.chatId === chatId ? null : currentChat,
            );
          } else {
            setIsChatSubmitting(false);
          }
        },
        onError(error) {
          didSettleSynchronously = true;
          chatHandleRef.current = null;
          if (!isMountedRef.current) {
            return;
          }

          if (!hasStarted) {
            setIsChatSubmitting(false);
            setChatDrawerError(error.message);
            return;
          }

          setChatsByChapter((previousChats) =>
            updateStoryChat(
              previousChats,
              chapterNumber,
              chatId,
              (entry) => ({
                ...entry,
                status: "failed",
                errorMessage: error.message,
              }),
            ),
          );
          setActiveStoryChat((currentChat) =>
            currentChat?.chatId === chatId ? null : currentChat,
          );
          toast.error(error.message);
        },
        onAuthRequired() {
          didSettleSynchronously = true;
          chatHandleRef.current = null;
          if (!isMountedRef.current) {
            return;
          }

          setIsChatSubmitting(false);
          setChatDrawerChapterNumber(null);
          setActiveStoryChat(null);
          void navigate("/login", { replace: true });
        },
      },
    );

    if (didSettleSynchronously) {
      handle.close();
    } else {
      chatHandleRef.current = handle;
    }
  }

  function handleCancelStoryChat(): void {
    chatHandleRef.current?.cancel();
  }

  function confirmAndCloseStoryChat(): boolean {
    const shouldLeave = window.confirm(
      "AI 正在回答，离开会取消回答并丢失本页聊天记录。确定离开吗？",
    );
    if (!shouldLeave) {
      return false;
    }

    chatHandleRef.current?.close();
    chatHandleRef.current = null;
    setIsChatSubmitting(false);
    setActiveStoryChat(null);
    return true;
  }

  function handleChatExpandedChange(
    chapterNumber: number,
    chatId: string,
    expanded: boolean,
  ): void {
    setChatsByChapter((previousChats) =>
      updateStoryChat(previousChats, chapterNumber, chatId, (entry) => ({
        ...entry,
        isExpanded: expanded,
      })),
    );
  }

  function handleChatReasoningExpandedChange(
    chapterNumber: number,
    chatId: string,
    expanded: boolean,
  ): void {
    setChatsByChapter((previousChats) =>
      updateStoryChat(previousChats, chapterNumber, chatId, (entry) => ({
        ...entry,
        isReasoningExpanded: expanded,
      })),
    );
  }

  const handleReaderViewportChange = useCallback(
    (state: StorylineReaderViewportState): void => {
      const previousPageIndex = previousReaderPageIndexRef.current;
      previousReaderPageIndexRef.current = state.currentPageIndex;
      readerPageIndexRef.current = state.currentPageIndex;
      setReaderPageIndex(state.currentPageIndex);
      setReaderViewport(state);

      if (
        previousPageIndex !== null &&
        previousPageIndex !== state.currentPageIndex
      ) {
        contentScrollRef.current?.scrollTo({
          behavior: "auto",
          top: 0,
        });
      }
    },
    [],
  );

  async function loadReaderChapter(
    targetPageIndex: number,
    returnPageIndex: number | null,
  ): Promise<void> {
    if (storyline === null) {
      return;
    }

    const requestId = chapterRequestIdRef.current + 1;
    chapterRequestIdRef.current = requestId;
    setChapterLoadStatus("loading");
    setChapterLoadErrorMessage(chapterLoadFailureMessage);
    setChapterReturnPageIndex(returnPageIndex);

    const result = await getStoryline(
      storyline.id,
      buildStorylineWindowQuery(targetPageIndex + 1),
    );
    if (!isMountedRef.current || chapterRequestIdRef.current !== requestId) {
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
      setChapterLoadErrorMessage(result.message);
      setChapterLoadStatus("failed");
      return;
    }

    applyLoadedStorylineWindow(result.storyline, targetPageIndex + 1);
  }

  function handleReaderPageChange(nextPageIndex: number): void {
    if (readerViewport === null || chapterLoadStatus === "loading") {
      return;
    }

    const safePageIndex = Math.min(
      Math.max(nextPageIndex, 0),
      readerViewport.pageCount - 1,
    );
    if (safePageIndex === readerViewport.currentPageIndex) {
      return;
    }

    const returnPageIndex = readerViewport.currentPageIndex;
    const pageNumber = safePageIndex + 1;
    readerPageIndexRef.current = safePageIndex;
    setReaderPageIndex(safePageIndex);
    setReaderViewport(
      buildReaderViewport(safePageIndex, readerViewport.pageCount),
    );
    setChapterLoadStatus("idle");
    setChapterReturnPageIndex(returnPageIndex);
    replaceStorylinePageInUrl(pageNumber, readerViewport.pageCount);
    contentScrollRef.current?.scrollTo({ behavior: "auto", top: 0 });

    if (storyline === null) {
      return;
    }

    if (
      pageNumber === storyline.chapterCount + 1 &&
      activeGenerationIntent?.type === "append"
    ) {
      return;
    }

    setStoryline((currentStoryline) =>
      currentStoryline === null
        ? null
        : trimStorylineWindow(currentStoryline, pageNumber),
    );
    if (findStorylineChapter(storyline, pageNumber) === undefined) {
      void loadReaderChapter(safePageIndex, returnPageIndex);
    }
  }

  function handleRetryChapterLoad(): void {
    const currentPageIndex = readerPageIndexRef.current;
    if (currentPageIndex === null) {
      return;
    }

    void loadReaderChapter(currentPageIndex, chapterReturnPageIndex);
  }

  function handleReturnFromChapterError(): void {
    if (storyline === null || chapterReturnPageIndex === null) {
      return;
    }

    const pageNumber = chapterReturnPageIndex + 1;
    readerPageIndexRef.current = chapterReturnPageIndex;
    setReaderPageIndex(chapterReturnPageIndex);
    setReaderViewport(
      buildReaderViewport(chapterReturnPageIndex, storyline.chapterCount),
    );
    setChapterLoadStatus("idle");
    setChapterReturnPageIndex(null);
    setStoryline((currentStoryline) =>
      currentStoryline === null
        ? null
        : trimStorylineWindow(currentStoryline, pageNumber),
    );
    replaceStorylinePageInUrl(pageNumber, storyline.chapterCount);
  }

  function handleSelectStoryAction(action: StoryActionKind): void {
    if (isGenerating || isChatBusy || storyline === null) {
      return;
    }

    if (action === "rewrite") {
      const latestGeneratedSegmentId =
        storyline.latestGeneration?.segmentId ?? null;
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
      toast.error(
        result.message.length > 0 ? result.message : settingSaveFailureMessage,
      );
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
    resetStoryReasoning();
    if (storyline === null) {
      previousReaderPageIndexRef.current = null;
      readerPageIndexRef.current = null;
      setReaderPageIndex(null);
      setReaderViewport(null);
    }
    setSubmittedCreateDraft(input.submittedCreateDraft);
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

    generationHandleRef.current = startStoryRealtimeGeneration(input.payload, {
      onStarted() {
        setStatus("streaming");
      },
      onSnapshot(snapshot) {
        if (intent.type !== "create" && intent.type !== "createFromSetting") {
          applyGenerationSnapshot(intent, snapshot);
          setGenerationStatusMessage("");
        }
      },
      onReasoning(delta) {
        if (!hasReceivedStoryReasoningRef.current) {
          hasReceivedStoryReasoningRef.current = true;
          setIsStoryReasoningExpanded(!hasReceivedStoryContentRef.current);
        }
        storyReasoningTextRef.current += delta;
        setStoryReasoningText(storyReasoningTextRef.current);
      },
      onChunk(delta) {
        setStatus("streaming");
        if (!hasReceivedStoryContentRef.current) {
          hasReceivedStoryContentRef.current = true;
          setIsStoryReasoningExpanded(false);
        }
        if (intent.type === "rewrite") {
          setTemporaryRewrite((previousDraft) => ({
            targetSegmentId: intent.segmentId,
            text: `${previousDraft?.text ?? ""}${delta}`,
          }));
          return;
        }

        if (intent.type === "dialogue") {
          setTemporaryDialogueText((previousText) => `${previousText}${delta}`);
          return;
        }

        setTemporaryAppendText((previousText) => `${previousText}${delta}`);
      },
      onPersisted(event) {
        if (
          input.payload.mode !== "create" &&
          input.payload.mode !== "createFromSetting"
        ) {
          void refreshPersistedStoryline(
            input.payload.storylineId,
            event.generatedSegmentId,
          );
        }
      },
      onContextStarted() {
        setStatus("updatingContext");
      },
      onContextFailed(message) {
        toast.error(message);
      },
      onCompleted(event) {
        generationHandleRef.current = null;
        persistedRefreshRequestIdRef.current += 1;
        setTemporaryAppendText("");
        setTemporaryDialogueText("");
        setTemporaryRewrite(null);
        setActiveGenerationIntent(null);
        setGenerationStatusMessage("");
        setStatus("completed");

        if (intent.type === "create" || intent.type === "createFromSetting") {
          setStoryline(event.storyline);
          setStoryReasoningHandoff({
            reasoningText: storyReasoningTextRef.current,
            storylineId: event.storyline.id,
          });
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

        const currentPageNumber = clampReaderPage(
          (readerPageIndexRef.current ?? event.storyline.anchorPage - 1) + 1,
          event.storyline.chapterCount,
        );
        const currentPageIndex = currentPageNumber - 1;
        readerPageIndexRef.current = currentPageIndex;
        setReaderPageIndex(currentPageIndex);
        setReaderViewport(
          buildReaderViewport(currentPageIndex, event.storyline.chapterCount),
        );
        setStoryline((currentStoryline) =>
          mergeStorylineWindow(
            currentStoryline,
            event.storyline,
            currentPageNumber,
          ),
        );
        replaceStorylinePageInUrl(
          currentPageNumber,
          event.storyline.chapterCount,
        );

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
        persistedRefreshRequestIdRef.current += 1;
        resetStoryReasoning();
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
        persistedRefreshRequestIdRef.current += 1;
        if (error.code !== "UNKNOWN") {
          resetStoryReasoning();
        }
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
      onReconnecting() {
        setGenerationStatusMessage(generationReconnectingMessage);
      },
      onAuthRequired() {
        generationHandleRef.current = null;
        persistedRefreshRequestIdRef.current += 1;
        resetStoryReasoning();
        setSubmittedCreateDraft(null);
        setActiveGenerationIntent(null);
        void navigate("/login", { replace: true });
      },
    });
  }

  function resetStoryReasoning(): void {
    storyReasoningTextRef.current = "";
    hasReceivedStoryContentRef.current = false;
    hasReceivedStoryReasoningRef.current = false;
    setStoryReasoningText("");
    setIsStoryReasoningExpanded(false);
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
    if (isChatBusy) {
      if (!confirmAndCloseStoryChat()) {
        return;
      }

      void navigate("/storylines");
      return;
    }

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
        hasStoryChatDrafts(chatDraftsByChapter),
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

    if (isChatBusy) {
      if (!confirmAndCloseStoryChat()) {
        return;
      }

      void navigate(`/storylines/${encodeURIComponent(storyline.id)}/context`);
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
        hasStoryChatDrafts(chatDraftsByChapter),
      )
    ) {
      const shouldLeave = window.confirm(
        "当前输入尚未提交，离开会丢失。确定打开上下文页面吗？",
      );
      if (!shouldLeave) {
        return;
      }
    }

    void navigate(`/storylines/${encodeURIComponent(storyline.id)}/context`);
  }

  function handleOpenCopyDialog(): void {
    if (
      storyline === null ||
      isGenerating ||
      isChatBusy ||
      chapterLoadStatus !== "idle"
    ) {
      return;
    }

    if (
      hasUnsavedDraft(
        initialStoryText,
        appendInstruction,
        rewriteInstruction,
        dialogueInput,
        hasStoryChatDrafts(chatDraftsByChapter),
      )
    ) {
      const shouldContinue = window.confirm(
        "当前输入尚未提交，复制成功后会离开本故事并丢失。确定继续吗？",
      );
      if (!shouldContinue) {
        return;
      }
    }

    setCopyError(undefined);
    setIsCopyDialogOpen(true);
  }

  function handleCloseCopyDialog(): void {
    if (isCopySubmitting) {
      return;
    }

    setIsCopyDialogOpen(false);
    setCopyError(undefined);
  }

  async function handleCopyStoryline(
    value: StorylineCopyDialogSubmitValue,
  ): Promise<void> {
    if (storyline === null || isCopySubmitting || isChatBusy) {
      return;
    }

    if (isGenerating) {
      setCopyError("当前故事正在处理中，请稍后重试");
      return;
    }

    const sourceStorylineId = storyline.id;
    setIsCopySubmitting(true);
    setCopyError(undefined);
    const result = await copyStoryline(sourceStorylineId, value);
    if (!isMountedRef.current) {
      return;
    }

    if (result.status === "authRequired") {
      setIsCopyDialogOpen(false);
      setIsCopySubmitting(false);
      void navigate("/login", { replace: true });
      return;
    }

    if (result.status === "notFound") {
      clearBackgroundPoll();
      setIsCopyDialogOpen(false);
      setIsCopySubmitting(false);
      setStoryline(null);
      setRestoreErrorTitle(notFoundFailureTitle);
      setRestoreErrorMessage(result.message);
      setStatus("restoreFailed");
      return;
    }

    if (
      result.status === "busy" ||
      result.status === "invalid" ||
      result.status === "failed"
    ) {
      setIsCopySubmitting(false);
      setCopyError(result.message);
      return;
    }

    setIsCopyDialogOpen(false);
    setIsCopySubmitting(false);
    setCopyError(undefined);
    toast.success(`已复制前 ${value.throughChapter} 章`);
    void navigate(`/storylines/${encodeURIComponent(result.storyline.id)}`);
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
          value={
            composerMode === "rewrite" ? rewriteInstruction : appendInstruction
          }
        />
      </>
    );
  }

  const latestGeneration = storyline?.latestGeneration ?? null;
  const currentReaderPageNumber =
    readerPageIndex === null ? null : readerPageIndex + 1;
  const defaultCopyChapter =
    storyline === null
      ? 1
      : Math.min(
          currentReaderPageNumber ?? storyline.chapterCount,
          storyline.chapterCount,
        );
  const isCurrentChapterAvailable =
    storyline === null ||
    currentReaderPageNumber === null ||
    findStorylineChapter(storyline, currentReaderPageNumber) !== undefined ||
    (activeGenerationIntent?.type === "append" &&
      currentReaderPageNumber === storyline.chapterCount + 1);
  const isCurrentChatChapterAvailable =
    storyline !== null &&
    currentReaderPageNumber !== null &&
    currentReaderPageNumber <= storyline.chapterCount &&
    findStorylineChapter(storyline, currentReaderPageNumber) !== undefined;
  const currentChapterChatEntries =
    currentReaderPageNumber === null
      ? []
      : (chatsByChapter[currentReaderPageNumber] ?? []);
  const isChatDisabled =
    !isCurrentChatChapterAvailable ||
    chapterLoadStatus !== "idle" ||
    isGenerating ||
    isCopySubmitting ||
    isChatBusy ||
    chatDrawerChapterNumber !== null;
  const chatDisabledReason = !isCurrentChatChapterAvailable
    ? "当前章节尚未加载完成"
    : isGenerating || isCopySubmitting || isChatBusy
      ? "当前故事正在处理中，请稍后重试"
      : undefined;

  return (
    <main
      aria-label="StoryAgent"
      className="story-page-viewport flex flex-col overflow-hidden [background:radial-gradient(circle_at_top_left,var(--accent-bg),transparent_28rem),var(--bg)]"
    >
      <StoryPageHeader
        chatDisabledReason={chatDisabledReason}
        isChatDisabled={isChatDisabled}
        isCopyDisabled={
          isGenerating || isChatBusy || chapterLoadStatus !== "idle"
        }
        key={storyline?.id ?? "story-workbench"}
        onBackToList={handleGoToStorylineList}
        onCopyStoryline={handleOpenCopyDialog}
        onOpenChat={handleOpenStoryChat}
        onOpenContext={handleOpenContextDebug}
        showStoryActions={storyline !== null}
        title={storyline?.title ?? "故事工作台"}
      />
      <section
        className={`scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-5 ${contentBottomPaddingClassName} md:px-6 md:pt-6`}
        ref={contentScrollRef}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
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
              <ReasoningPanel
                isExpanded={isStoryReasoningExpanded}
                isThinking={isGenerating && !hasReceivedStoryContentRef.current}
                onExpandedChange={setIsStoryReasoningExpanded}
                text={storyReasoningText}
              />

              {storyline !== null && chapterLoadStatus === "failed" ? (
                <StoryChapterLoadError
                  message={chapterLoadErrorMessage}
                  onBack={handleReturnFromChapterError}
                  onRetry={handleRetryChapterLoad}
                />
              ) : storyline !== null && !isCurrentChapterAvailable ? (
                <StoryChapterLoading />
              ) : storyline !== null ? (
                <StorylineReader
                  chatEntries={currentChapterChatEntries}
                  onChatExpandedChange={(chatId, expanded) => {
                    if (currentReaderPageNumber !== null) {
                      handleChatExpandedChange(
                        currentReaderPageNumber,
                        chatId,
                        expanded,
                      );
                    }
                  }}
                  onChatReasoningExpandedChange={(chatId, expanded) => {
                    if (currentReaderPageNumber !== null) {
                      handleChatReasoningExpandedChange(
                        currentReaderPageNumber,
                        chatId,
                        expanded,
                      );
                    }
                  }}
                  onViewportChange={handleReaderViewportChange}
                  pageIndex={readerPageIndex}
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
                  chatEntries={[]}
                  initialInstruction={submittedCreateDraft.instruction}
                  onChatExpandedChange={ignoreChatExpansionChange}
                  onChatReasoningExpandedChange={ignoreChatExpansionChange}
                  onViewportChange={handleReaderViewportChange}
                  pageIndex={readerPageIndex}
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
        </div>
      </section>

      {isCopyDialogOpen && storyline !== null ? (
        <StorylineCopyDialog
          chapterCount={storyline.chapterCount}
          defaultThroughChapter={defaultCopyChapter}
          error={copyError}
          isSubmitting={isCopySubmitting}
          onClose={handleCloseCopyDialog}
          onInputChange={() => setCopyError(undefined)}
          onSubmit={(value) => {
            void handleCopyStoryline(value);
          }}
          sourceTitle={storyline.title}
        />
      ) : null}

      {isPaginationBarVisible && readerViewport !== null ? (
        <StoryPaginationBar
          isNextDisabled={
            chapterLoadStatus === "loading" ||
            !isCurrentChapterAvailable ||
            readerViewport.currentPageIndex >= readerViewport.pageCount - 1
          }
          isPreviousDisabled={
            chapterLoadStatus === "loading" ||
            !isCurrentChapterAvailable ||
            readerViewport.currentPageIndex === 0
          }
          label={readerViewport.pageLabel}
          onNext={() =>
            handleReaderPageChange(readerViewport.currentPageIndex + 1)
          }
          onPrevious={() =>
            handleReaderPageChange(readerViewport.currentPageIndex - 1)
          }
        />
      ) : null}

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

      {chatDrawerChapterNumber !== null ? (
        <StoryChatDrawer
          chapterNumber={chatDrawerChapterNumber}
          error={chatDrawerError}
          isSubmitting={isChatSubmitting}
          onChange={handleChatDraftChange}
          onClose={handleCloseChatDrawer}
          onSubmit={handleSubmitStoryChat}
          value={chatDraftsByChapter[chatDrawerChapterNumber] ?? ""}
        />
      ) : null}

      {activeStoryChat !== null ? (
        <StoryChatFloatingStatus
          chapterNumber={activeStoryChat.chapterNumber}
          hasBottomBar={isPaginationBarVisible}
          onCancel={handleCancelStoryChat}
        />
      ) : (
        <StoryActionFab
          availableActions={availableActions}
          hasBottomBar={isPaginationBarVisible}
          isGenerating={isGenerating}
          isVisible={isActionFabVisible}
          onCancelGeneration={handleCancel}
          onSelectAction={handleSelectStoryAction}
        />
      )}
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
    anchorPage: 1,
    chapterCount: 1,
    chapters: [
      {
        pageNumber: 1,
        segments: [
          {
            id: submittedCreateInitialSegmentId,
            text: draft.initialStoryText,
            type: "initial",
          },
        ],
      },
    ],
    id: submittedCreateStorylineId,
    title: buildSubmittedCreateTitle(draft.initialStoryText),
    latestGeneration: null,
    updatedAt: submittedCreateUpdatedAt,
  };
}

function buildSubmittedCreateTitle(initialStoryText: string): string {
  const firstLine =
    initialStoryText
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, " "))
      .find((line) => line.length > 0) ?? "新故事";

  return firstLine.length <= 80
    ? firstLine
    : `${firstLine.slice(0, 77).trimEnd()}...`;
}

function buildStorylineWindowQuery(
  anchorPage: number | "latest",
): StorylineWindowQuery {
  return {
    anchorPage,
    before: STORYLINE_CHAPTER_CACHE_RADIUS,
    after: STORYLINE_CHAPTER_CACHE_RADIUS,
  };
}

function readStorylinePageFromCurrentLocation(): number | "latest" {
  const value = new URLSearchParams(window.location.search).get("page");
  if (value === null || value.length === 0) {
    return "latest";
  }

  if (!/^-?\d+$/.test(value)) {
    return "latest";
  }

  const pageNumber = Number(value);
  return Number.isSafeInteger(pageNumber) ? pageNumber : "latest";
}

function replaceStorylinePageInUrl(
  pageNumber: number,
  chapterCount: number,
): void {
  const url = new URL(window.location.href);
  if (pageNumber >= chapterCount) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(pageNumber));
  }
  window.history.replaceState(window.history.state, "", url);
}

function clampReaderPage(pageNumber: number, chapterCount: number): number {
  return Math.min(Math.max(pageNumber, 1), chapterCount);
}

function buildReaderViewport(
  pageIndex: number,
  pageCount: number,
): StorylineReaderViewportState {
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  return {
    currentPageIndex: safePageIndex,
    isViewingLatestPage: safePageIndex === pageCount - 1,
    pageCount,
    pageLabel: `第 ${safePageIndex + 1} / ${pageCount} 章`,
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

function getRecoveryIntent(
  recovery: StoryGenerationRecoveryResponse,
): Exclude<GenerationIntent, { type: "create" | "createFromSetting" }> | null {
  const task = recovery.task;
  if (task === null || recovery.snapshot === null) {
    return null;
  }

  switch (task.mode) {
    case "append":
      return { type: "append" };
    case "dialogue":
      return { type: "dialogue" };
    case "rewrite":
      return recovery.snapshot.rewriteTargetSegmentId === undefined
        ? null
        : {
            type: "rewrite",
            segmentId: recovery.snapshot.rewriteTargetSegmentId,
          };
    case "create":
    case "createFromSetting":
      return null;
  }
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
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
  hasChatDraft: boolean,
): boolean {
  return (
    initialStoryText.trim().length > 0 ||
    appendInstruction.trim().length > 0 ||
    rewriteInstruction.trim().length > 0 ||
    dialogueInput.trim().length > 0 ||
    hasChatDraft
  );
}

function ignoreChatExpansionChange(
  _chatId: string,
  _expanded: boolean,
): void {
  return undefined;
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

interface StoryPaginationBarProps {
  isNextDisabled: boolean;
  isPreviousDisabled: boolean;
  label: string;
  onNext: () => void;
  onPrevious: () => void;
}

function StoryPaginationBar({
  isNextDisabled,
  isPreviousDisabled,
  label,
  onNext,
  onPrevious,
}: StoryPaginationBarProps): JSX.Element {
  const buttonClassName =
    "min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h) transition-[border-color,transform,opacity] duration-200 enabled:hover:-translate-y-px enabled:hover:border-(--accent-border) disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <footer className="z-10 box-border h-[calc(4rem+env(safe-area-inset-bottom))] shrink-0 border-t border-(--border) bg-(--panel-bg) px-4 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_24px_rgba(0,0,0,0.08)] backdrop-blur md:px-6">
      <div className="mx-auto grid h-full w-full max-w-3xl grid-cols-3 items-center gap-3">
        <button
          className={buttonClassName}
          disabled={isPreviousDisabled}
          onClick={onPrevious}
          type="button"
        >
          上一章
        </button>
        <p className="m-0 truncate text-center text-xs font-semibold text-(--text)">
          {label}
        </p>
        <button
          className={buttonClassName}
          disabled={isNextDisabled}
          onClick={onNext}
          type="button"
        >
          下一章
        </button>
      </div>
    </footer>
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

function StoryChapterLoading(): JSX.Element {
  return (
    <section
      aria-label="正在加载章节"
      className="flex min-h-64 animate-pulse flex-col gap-5"
      role="status"
    >
      <div className="mx-auto h-3 w-24 rounded-full bg-(--border)" />
      <div className="h-4 w-full rounded-full bg-(--border)" />
      <div className="h-4 w-11/12 rounded-full bg-(--border)" />
      <div className="h-4 w-4/5 rounded-full bg-(--border)" />
      <div className="h-4 w-full rounded-full bg-(--border)" />
      <p className="sr-only">正在加载章节...</p>
    </section>
  );
}

function StoryChapterLoadError({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onRetry: () => void;
}): JSX.Element {
  const buttonClassName =
    "min-h-10 rounded-full border border-(--border) bg-transparent px-4 py-2 text-sm font-bold text-(--text-h) transition-[border-color,transform] hover:-translate-y-px hover:border-(--accent-border)";

  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-6 text-center shadow-(--shadow)">
      <h2 className="m-0 text-lg font-bold text-(--text-h)">章节加载失败</h2>
      <p className="mt-3 mb-5 text-sm text-(--text)">{message}</p>
      <div className="flex justify-center gap-3">
        <button className={buttonClassName} onClick={onBack} type="button">
          返回原章节
        </button>
        <button className={buttonClassName} onClick={onRetry} type="button">
          重试
        </button>
      </div>
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
