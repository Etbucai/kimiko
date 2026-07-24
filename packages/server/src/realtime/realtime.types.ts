import type { AccessTokenPayload } from "../auth/auth.types";

export type RealtimeErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_PAYLOAD"
  | "BUSY"
  | "NO_ACTIVE_TASK"
  | "GENERATION_FAILED"
  | "LLM_EMPTY_RESPONSE"
  | "LLM_USAGE_MISSING"
  | "STORYLINE_NOT_FOUND"
  | "STORYLINE_BUSY"
  | "STORYLINE_SAVE_FAILED"
  | "STORY_SUMMARY_FAILED"
  | "STORY_CONTEXT_FAILED"
  | "STORY_SEGMENT_NOT_REWRITABLE";

export interface ActiveRealtimeTask {
  requestId: string;
}

export interface RealtimeClientState {
  activeTask: ActiveRealtimeTask | null;
  user: Pick<AccessTokenPayload, "sub" | "uniqueName"> | null;
}
