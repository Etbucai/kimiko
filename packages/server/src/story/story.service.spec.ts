import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
} from "@kimiko/schema";
import type { LlmProvider } from "../llm/llm.provider";
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
    };
    storyService = new StoryService(new LlmService(llmProvider));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds the story prompt and maps the LLM response", async () => {
    jest.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_042);
    llmProvider.generateText.mockResolvedValue({
      text: "  林夏继续向钟楼走去。  ",
      model: "story-model",
      usage: {
        inputTokens: 20,
        outputTokens: 80,
        totalTokens: 100,
      },
    });

    await expect(
      storyService.continueStory({
        storyText: "  雨停以后，林夏走出旧书店。  ",
        instruction: "  林夏前往钟楼调查。  ",
      }),
    ).resolves.toEqual({
      continuedStory: "林夏继续向钟楼走去。",
      model: "story-model",
      elapsedMs: 42,
      usage: {
        inputTokens: 20,
        outputTokens: 80,
        totalTokens: 100,
      },
    });

    expect(llmProvider.generateText.mock.calls[0]?.[0]).toEqual({
      systemPrompt: STORY_SYSTEM_PROMPT,
      userPrompt: [
        "故事正文：",
        "雨停以后，林夏走出旧书店。",
        "",
        "续写指令：",
        "林夏前往钟楼调查。",
      ].join("\n"),
    });
  });

  it("rejects invalid request bodies", async () => {
    await expect(
      storyService.continueStory({
        storyText: "   ",
        instruction: "go",
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "   ",
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "go",
        model: "client-model",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects empty model output and missing token usage", async () => {
    llmProvider.generateText.mockResolvedValueOnce({
      text: "   ",
      model: "story-model",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "go",
      }),
    ).rejects.toThrow(BadGatewayException);

    llmProvider.generateText.mockResolvedValueOnce({
      text: "continued story",
      model: "story-model",
    });

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "go",
      }),
    ).rejects.toThrow(BadGatewayException);

    llmProvider.generateText.mockResolvedValueOnce({
      text: "continued story",
      model: "story-model",
      usage: {
        inputTokens: 1,
        totalTokens: 2,
      },
    });

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "go",
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it("keeps LLM provider failures mapped by the LLM layer", async () => {
    llmProvider.generateText.mockRejectedValue(
      new ServiceUnavailableException("LLM provider is unavailable"),
    );

    await expect(
      storyService.continueStory({
        storyText: "story",
        instruction: "go",
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
