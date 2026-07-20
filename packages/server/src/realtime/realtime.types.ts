import type { AccessTokenPayload } from "../auth/auth.types";

export type RealtimeErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_PAYLOAD"
  | "BUSY"
  | "NO_ACTIVE_TASK"
  | "GENERATION_FAILED"
  | "LLM_EMPTY_RESPONSE"
  | "LLM_USAGE_MISSING";

export interface ActiveRealtimeTask {
  abortController: AbortController;
  requestId: string;
}

export interface RealtimeClientState {
  activeTask: ActiveRealtimeTask | null;
  user: Pick<AccessTokenPayload, "sub" | "uniqueName"> | null;
}
