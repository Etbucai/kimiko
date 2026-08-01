import { ConflictException, PayloadTooLargeException } from "@nestjs/common";
import type { StoryChapterChatStreamEvent } from "@kimiko/schema";
import { StoryChapterChatStreamEventSchema } from "@kimiko/schema";
import { StorylineChatController } from "./storyline-chat.controller";
import type { StorylineChatService } from "./storyline-chat.service";
import type { PreparedStoryChatSession } from "./storyline-chat.types";
import {
  StoryChatContextTooLargeError,
  StoryChatEmptyResponseError,
  StorylineBusyError,
} from "./storyline.errors";

describe("StorylineChatController", () => {
  it("streams started, reasoning, answer, and completed events", async () => {
    const session = createSession([
      {
        type: "reasoning_chunk",
        sequence: 1,
        delta: "先分析。",
      },
      {
        type: "answer_chunk",
        sequence: 1,
        delta: "转折略快。",
      },
      { type: "completed" },
    ]);
    const chatService = {
      prepare: jest.fn().mockResolvedValue(session),
    };
    const controller = new StorylineChatController(
      chatService as unknown as StorylineChatService,
    );
    const response = createResponse();

    await controller.streamChapterChat(
      { userId: "1", uniqueName: "chat_user" },
      "5",
      { chapterNumber: 3, topic: "分析转折。" },
      response.value,
    );

    expect(chatService.prepare).toHaveBeenCalledWith({
      body: { chapterNumber: 3, topic: "分析转折。" },
      storylineId: "5",
      userId: "1",
    });
    expect(parseEvents(response.writtenChunks)).toEqual([
      { type: "started" },
      {
        type: "reasoning_chunk",
        sequence: 1,
        delta: "先分析。",
      },
      {
        type: "answer_chunk",
        sequence: 1,
        delta: "转折略快。",
      },
      { type: "completed" },
    ]);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/x-ndjson; charset=utf-8",
    );
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it("maps stream errors after started without exposing error details", async () => {
    const session = createFailingSession(
      new StoryChatEmptyResponseError("private failure detail"),
    );
    const controller = new StorylineChatController({
      prepare: jest.fn().mockResolvedValue(session),
    } as unknown as StorylineChatService);
    const response = createResponse();

    await controller.streamChapterChat(
      { userId: "1", uniqueName: "chat_user" },
      "5",
      { chapterNumber: 3, topic: "分析转折。" },
      response.value,
    );

    expect(parseEvents(response.writtenChunks)).toEqual([
      { type: "started" },
      {
        type: "error",
        code: "LLM_EMPTY_RESPONSE",
        message: "AI 没有返回回答，请重新提问",
      },
    ]);
    expect(response.writtenChunks.join("")).not.toContain(
      "private failure detail",
    );
    expect(session.release).toHaveBeenCalledTimes(1);
  });

  it("maps preparation failures before starting the stream", async () => {
    const busyController = new StorylineChatController({
      prepare: jest.fn().mockRejectedValue(new StorylineBusyError()),
    } as unknown as StorylineChatService);
    const busyResponse = createResponse();

    await expect(
      busyController.streamChapterChat(
        { userId: "1", uniqueName: "chat_user" },
        "5",
        { chapterNumber: 3, topic: "分析转折。" },
        busyResponse.value,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(busyResponse.writtenChunks).toEqual([]);
    expect(busyResponse.end).not.toHaveBeenCalled();

    const largeController = new StorylineChatController({
      prepare: jest.fn().mockRejectedValue(new StoryChatContextTooLargeError()),
    } as unknown as StorylineChatService);
    const largeResponse = createResponse();
    await expect(
      largeController.streamChapterChat(
        { userId: "1", uniqueName: "chat_user" },
        "5",
        { chapterNumber: 3, topic: "分析转折。" },
        largeResponse.value,
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(largeResponse.writtenChunks).toEqual([]);
  });

  it("aborts the stream and releases the session when the response closes", async () => {
    let observedSignal: AbortSignal | undefined;
    const release = jest.fn();
    const session: PreparedStoryChatSession = {
      chapterNumber: 3,
      requestId: "request-1",
      release,
      stream(options) {
        observedSignal = options.signal;
        return createStream([]);
      },
    };
    const controller = new StorylineChatController({
      prepare: jest.fn().mockResolvedValue(session),
    } as unknown as StorylineChatService);
    const response = createResponse({
      closeAfterFirstWrite: true,
    });

    await controller.streamChapterChat(
      { userId: "1", uniqueName: "chat_user" },
      "5",
      { chapterNumber: 3, topic: "分析转折。" },
      response.value,
    );

    expect(observedSignal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function createSession(
  events: Parameters<typeof createStream>[0],
): PreparedStoryChatSession {
  return {
    chapterNumber: 3,
    requestId: "request-1",
    release: jest.fn(),
    stream: () => createStream(events),
  };
}

function createFailingSession(error: Error): PreparedStoryChatSession {
  return {
    chapterNumber: 3,
    requestId: "request-1",
    release: jest.fn(),
    stream: () => createFailingStream(error),
  };
}

async function* createStream(events: readonly StoryChapterChatStreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}

function createFailingStream(error: Error) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(error),
      };
    },
  };
}

function createResponse(
  options: Readonly<{ closeAfterFirstWrite?: boolean }> = {},
) {
  const writtenChunks: string[] = [];
  let closeListener: (() => void) | undefined;
  let writableEnded = false;
  const setHeader = jest.fn();
  const end = jest.fn();
  const value: MockStreamResponse = {
    get writableEnded() {
      return writableEnded;
    },
    end(chunk?: string) {
      writableEnded = true;
      end(chunk);
      return value;
    },
    flushHeaders: jest.fn(),
    on: jest.fn((_event: "close", listener: () => void) => {
      closeListener = listener;
      return value;
    }),
    setHeader: jest.fn((name: string, headerValue: string) => {
      setHeader(name, headerValue);
      return value;
    }),
    write: jest.fn((chunk: string) => {
      writtenChunks.push(chunk);
      if (options.closeAfterFirstWrite === true && writtenChunks.length === 1) {
        closeListener?.();
      }
      return true;
    }),
  };

  return {
    end,
    setHeader,
    value,
    writtenChunks,
  };
}

function parseEvents(chunks: readonly string[]) {
  return chunks.map((chunk) => {
    const result = StoryChapterChatStreamEventSchema.safeParse(
      JSON.parse(chunk) as unknown,
    );
    expect(result.success).toBe(true);
    if (!result.success) {
      throw result.error;
    }
    return result.data;
  });
}

interface MockStreamResponse {
  readonly writableEnded: boolean;
  end(chunk?: string): MockStreamResponse;
  flushHeaders(): void;
  on(event: "close", listener: () => void): MockStreamResponse;
  setHeader(name: string, value: string): MockStreamResponse;
  write(chunk: string): boolean;
}
