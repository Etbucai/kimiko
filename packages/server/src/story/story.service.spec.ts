import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import type { LlmProvider, LlmTextStreamEvent } from "../llm/llm.provider";
import { LlmService } from "../llm/llm.service";
import { STORY_SYSTEM_PROMPT, StoryService } from "./story.service";

describe("StoryService", () => {
  let llmProvider: jest.Mocked<LlmProvider>;
  let storyService: StoryService;

  beforeEach(() => {
    llmProvider = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest]
      >(),
      streamText: jest.fn<
        AsyncIterable<LlmTextStreamEvent>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
      >(),
    };
    storyService = new StoryService(new LlmService(llmProvider));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects invalid request bodies", async () => {
    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "   ",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "   ",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
            model: "client-model",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("keeps LLM provider failures mapped by the LLM layer", async () => {
    llmProvider.streamText.mockReturnValue(
      createFailingStream(
        new ServiceUnavailableException("LLM provider is unavailable"),
      ),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it("streams story chunks and completes with accumulated metadata", async () => {
    jest.spyOn(Date, "now").mockReturnValueOnce(2_000).mockReturnValueOnce(2_050);
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "chunk",
          delta: "林夏",
        },
        {
          type: "chunk",
          delta: "走向钟楼。",
        },
        {
          type: "completed",
          model: "story-model",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
        },
      ]),
    );

    const events = await collectAsyncIterable(
      storyService.streamContinueStory(
        {
          storyText: "  雨停以后。  ",
          instruction: "  继续调查。  ",
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(events).toEqual([
      {
        type: "chunk",
        delta: "林夏",
        sequence: 1,
      },
      {
        type: "chunk",
        delta: "走向钟楼。",
        sequence: 2,
      },
      {
        type: "completed",
        continuedStory: "林夏走向钟楼。",
        model: "story-model",
        elapsedMs: 50,
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
        },
      },
    ]);
    expect(llmProvider.streamText.mock.calls[0]?.[0]).toEqual({
      systemPrompt: STORY_SYSTEM_PROMPT,
      userPrompt: ["故事正文：", "雨停以后。", "", "续写指令：", "继续调查。"].join(
        "\n",
      ),
    });
  });

  it("rejects empty streamed output", async () => {
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "completed",
          model: "story-model",
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            totalTokens: 1,
          },
        },
      ]),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadGatewayException);
  });

  it("rejects empty streamed model", async () => {
    llmProvider.streamText.mockReturnValue(
      createStream([
        {
          type: "chunk",
          delta: "continued story",
        },
        {
          type: "completed",
          model: "   ",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
      ]),
    );

    await expect(
      collectAsyncIterable(
        storyService.streamContinueStory(
          {
            storyText: "story",
            instruction: "go",
          },
          { signal: new AbortController().signal },
        ),
      ),
    ).rejects.toThrow(BadGatewayException);
  });
});

async function* createStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }

  return events;
}

function createFailingStream(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        async next(): Promise<IteratorResult<never>> {
          throw error;
        },
      };
    },
  };
}
