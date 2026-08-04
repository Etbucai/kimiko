import type {
  CancelStoryGenerationResponse,
  StoryContinuePayload,
  StoryGenerationRecoveryResponse,
  StoryGenerationMode,
  StoryGenerationPhase,
  StoryGenerationStreamSnapshot,
  StoryGenerationStatusResponse,
  StoryGenerationTask,
  StoryRealtimeErrorCode,
} from "@kimiko/schema";
import type { RealtimeErrorCode } from "../realtime/realtime.types";
import type { StorylineStreamEvent } from "./storyline.types";

export type StoryGenerationTaskKey =
  `create:${string}:${string}` | `storyline:${string}:${string}`;

export type StoryGenerationTaskStatus = StoryGenerationTask["status"];

export interface StoryGenerationObserver {
  readonly observerId: string;
  readonly requestId: string;
  sendStarted(): void;
  sendSnapshot(snapshot: StoryGenerationStreamSnapshot): void;
  sendReasoning(
    event: Extract<StorylineStreamEvent, { type: "reasoning" }>,
  ): void;
  sendChunk(event: Extract<StorylineStreamEvent, { type: "chunk" }>): void;
  sendPersisted(generatedSegmentId: string): void;
  sendContextStarted(): void;
  sendContextFailed(message: string): void;
  sendCompleted(
    event: Extract<StorylineStreamEvent, { type: "completed" }>,
  ): void;
  sendCancelled(): void;
  sendError(input: {
    readonly code: RealtimeErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  }): void;
}

export interface StoryGenerationTaskRecord {
  readonly abortController: AbortController;
  readonly key: StoryGenerationTaskKey;
  readonly mode: StoryGenerationMode;
  readonly requestId: string;
  readonly startedAt: number;
  readonly storylineId: string | null;
  readonly userId: string;
  readonly rewriteTargetSegmentId: string | null;
  readonly observers: Set<StoryGenerationObserver>;
  bufferedBytes: number;
  cleanupTimer: NodeJS.Timeout | null;
  errorCode: StoryRealtimeErrorCode | null;
  expiresAt: number | null;
  generatedSegmentId: string | null;
  message: string | null;
  outputPersisted: boolean;
  phase: StoryGenerationPhase;
  reasoningSequence: number;
  reasoningText: string;
  status: StoryGenerationTaskStatus;
  streamSequence: number;
  streamText: string;
  terminalAt: number | null;
}

export interface StartStoryGenerationTaskInput {
  readonly observer: StoryGenerationObserver;
  readonly payload: StoryContinuePayload;
  readonly requestId: string;
  readonly userId: string;
}

export type StartStoryGenerationTaskResult =
  | Readonly<{ status: "started"; task: StoryGenerationTaskRecord }>
  | Readonly<{ status: "busy"; code: "BUSY" | "STORYLINE_BUSY" }>;

export interface CancelByRequestInput {
  readonly activeRequestId: string | null;
  readonly requestId: string;
  readonly userId: string;
}

export type CancelByRequestResult =
  | Readonly<{ status: "cancelled"; task: StoryGenerationTaskRecord }>
  | Readonly<{ status: "notCancelled"; task: StoryGenerationTaskRecord }>
  | Readonly<{ status: "noActiveTask" }>
  | Readonly<{ status: "completed"; task: StoryGenerationTaskRecord }>;

export interface CancelByStorylineInput {
  readonly storylineId: string;
  readonly userId: string;
}

export type CancelByStorylineResult = CancelStoryGenerationResponse;

export type CancelTaskStateResult =
  | Readonly<{
      cancelled: true;
      response: CancelStoryGenerationResponse;
      task: StoryGenerationTaskRecord;
    }>
  | Readonly<{
      cancelled: false;
      response: CancelStoryGenerationResponse;
      task: StoryGenerationTaskRecord | null;
    }>;

export interface DetachObserverInput {
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly observerId: string;
  readonly requestId: string;
  readonly userId: string;
}

export interface AttachObserverInput {
  readonly observer: StoryGenerationObserver;
  readonly requestId: string;
  readonly storylineId: string;
  readonly userId: string;
}

export type AttachObserverResult =
  | Readonly<{
      status: "attached";
      task: StoryGenerationTaskRecord;
      snapshot: StoryGenerationStreamSnapshot;
    }>
  | Readonly<{
      status: "persisted";
      task: StoryGenerationTaskRecord;
      generatedSegmentId: string;
    }>
  | Readonly<{
      status: "cancelled" | "failed" | "notFound";
      task: StoryGenerationTaskRecord | null;
    }>;

export interface GetStorylineTaskStatusInput {
  readonly storylineId: string;
  readonly userId: string;
}

export type GetStorylineTaskStatusResult = StoryGenerationStatusResponse;

export interface GetStorylineTaskRecoveryInput {
  readonly storylineId: string;
  readonly userId: string;
}

export type GetStorylineTaskRecoveryResult = StoryGenerationRecoveryResponse;

export interface CompleteTaskInput {
  readonly generatedSegmentId: string;
}

export interface PersistTaskInput {
  readonly generatedSegmentId: string;
}

export interface FailTaskInput {
  readonly code: StoryRealtimeErrorCode;
  readonly message: string;
}

export interface TaskSnapshotInput {
  readonly task: StoryGenerationTaskRecord;
}
