import type { GenerateLlmTextRequest } from "@kimiko/schema";
import { StorySettingCompletionStreamEventSchema } from "@kimiko/schema";
import type { LlmTextStreamEvent } from "../llm/llm.provider";
import type { LlmService } from "../llm/llm.service";
import { StorySettingController } from "./story-setting.controller";
import type { StorySettingService } from "./story-setting.service";

describe("StorySettingController", () => {
  it("streams reasoning separately from setting content", async () => {
    const llmRequest: GenerateLlmTextRequest = {
      userPrompt: "complete this setting",
    };
    const llmService: Pick<LlmService, "streamTextFromParsedRequest"> = {
      streamTextFromParsedRequest: jest.fn().mockReturnValue(
        createLlmStream([
          { type: "reasoning", delta: "先分析题材。" },
          { type: "reasoning", delta: "再组织人物关系。" },
          { type: "chunk", delta: "完整故事设定" },
          {
            type: "completed",
            model: "test-model",
            usage: {
              inputTokens: 10,
              outputTokens: 8,
              reasoningTokens: 4,
              totalTokens: 18,
            },
          },
        ]),
      ),
    };
    const storySettingService: Pick<
      StorySettingService,
      "buildCompletionLlmRequest"
    > = {
      buildCompletionLlmRequest: jest.fn().mockReturnValue(llmRequest),
    };
    const controller = new StorySettingController(
      llmService as LlmService,
      storySettingService as StorySettingService,
    );
    const writtenChunks: string[] = [];
    const request = {
      on: jest.fn(),
    };
    request.on.mockReturnValue(request);
    const response = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        writtenChunks.push(chunk);
        return true;
      }),
      end: jest.fn(),
    };
    response.setHeader.mockReturnValue(response);
    response.end.mockReturnValue(response);

    await controller.completeStream(
      { mode: "complete", inspiration: "灵感" },
      request,
      response,
    );

    const events = writtenChunks.map((chunk) => {
      const result = StorySettingCompletionStreamEventSchema.safeParse(
        JSON.parse(chunk) as unknown,
      );
      expect(result.success).toBe(true);
      if (!result.success) {
        throw result.error;
      }
      return result.data;
    });
    expect(events).toEqual([
      { type: "started" },
      {
        type: "reasoning_chunk",
        sequence: 1,
        delta: "先分析题材。",
      },
      {
        type: "reasoning_chunk",
        sequence: 2,
        delta: "再组织人物关系。",
      },
      {
        type: "chunk",
        sequence: 1,
        delta: "完整故事设定",
      },
      {
        type: "completed",
        model: "test-model",
        elapsedMs: expect.any(Number),
        usage: {
          inputTokens: 10,
          outputTokens: 8,
          reasoningTokens: 4,
          totalTokens: 18,
        },
      },
    ]);
    expect(storySettingService.buildCompletionLlmRequest).toHaveBeenCalledWith({
      mode: "complete",
      inspiration: "灵感",
    });
    expect(llmService.streamTextFromParsedRequest).toHaveBeenCalledWith(
      llmRequest,
      { signal: expect.any(AbortSignal) },
    );
  });
});

async function* createLlmStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}
