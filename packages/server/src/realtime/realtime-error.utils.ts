import { BadGatewayException } from "@nestjs/common";
import type { StoryRealtimeErrorCode } from "@kimiko/schema";
import {
  StoryContextFailedError,
  StorySegmentNotRewritableError,
  StorylineBusyError,
  StorylineNotFoundError,
  StorylineSaveFailedError,
} from "../storyline/storyline.errors";

export const realtimeErrorMessages: Record<StoryRealtimeErrorCode, string> = {
  INVALID_MESSAGE: "消息格式不正确",
  INVALID_PAYLOAD: "请求参数不正确",
  BUSY: "当前连接已有生成任务",
  NO_ACTIVE_TASK: "当前没有可取消的生成任务",
  GENERATION_FAILED: "生成失败，请稍后重试",
  LLM_EMPTY_RESPONSE: "生成结果为空，请稍后重试",
  LLM_USAGE_MISSING: "生成元数据缺失，请稍后重试",
  STORYLINE_NOT_FOUND: "故事线不存在",
  STORYLINE_BUSY: "当前故事线正在生成，请稍后重试",
  STORYLINE_SAVE_FAILED: "保存失败，请稍后重试",
  STORY_SUMMARY_FAILED: "生成失败，请稍后重试",
  STORY_CONTEXT_FAILED: "生成失败，请稍后重试",
  STORY_SEGMENT_NOT_REWRITABLE: "当前段落不可重写",
};

export function getRealtimeErrorMessage(code: StoryRealtimeErrorCode): string {
  return realtimeErrorMessages[code];
}

export function mapRealtimeStreamErrorCode(
  error: unknown,
): StoryRealtimeErrorCode {
  if (error instanceof StorylineNotFoundError) {
    return "STORYLINE_NOT_FOUND";
  }

  if (error instanceof StorylineBusyError) {
    return "STORYLINE_BUSY";
  }

  if (error instanceof StorylineSaveFailedError) {
    return "STORYLINE_SAVE_FAILED";
  }

  if (error instanceof StorySegmentNotRewritableError) {
    return "STORY_SEGMENT_NOT_REWRITABLE";
  }

  if (error instanceof StoryContextFailedError) {
    return "STORY_CONTEXT_FAILED";
  }

  if (error instanceof BadGatewayException) {
    const response = error.getResponse();
    const message =
      typeof response === "string"
        ? response
        : typeof response === "object" &&
            response !== null &&
            "message" in response &&
            typeof response.message === "string"
          ? response.message
          : "";

    if (message.includes("empty")) {
      return "LLM_EMPTY_RESPONSE";
    }

    if (message.includes("usage")) {
      return "LLM_USAGE_MISSING";
    }
  }

  return "GENERATION_FAILED";
}
