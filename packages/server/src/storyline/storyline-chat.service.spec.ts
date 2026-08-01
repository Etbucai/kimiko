import type { INestApplication } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  StoryChapterChatStreamEvent,
  StoryContextSnapshot,
} from "@kimiko/schema";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import {
  storylineContexts,
  storylineSegments,
  users,
} from "../database/schema";
import { reloadEnvForTesting } from "../env";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamOptions,
  type LlmTextStreamEvent,
} from "../llm/llm.provider";
import {
  StoryChapterNotFoundError,
  StoryChatContextTooLargeError,
  StoryChatEmptyResponseError,
  StorylineBusyError,
} from "./storyline.errors";
import {
  STORY_CHAPTER_CHAT_SYSTEM_PROMPT,
  StorylineChatService,
} from "./storyline-chat.service";
import { serializeStoryContext } from "./storyline-context-normalize";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

describe("StorylineChatService", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication | undefined;
  let chatService: StorylineChatService;
  let databaseService: DatabaseService;
  let llmProvider: jest.Mocked<LlmProvider>;
  let lockService: StorylineLockService;
  let logDirectory: string;
  let storylineService: StorylineService;

  beforeEach(async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.LLM_BASE_URL = "";
    process.env.LLM_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.LLM_TIMEOUT_MS = "";
    logDirectory = await mkdtemp(join(tmpdir(), "kimiko-chat-log-"));
    process.env.KIMIKO_LLM_CALL_LOG_DIR = logDirectory;
    reloadEnvForTesting();

    llmProvider = createLlmProvider([
      { type: "reasoning", delta: "先分析人物动机。" },
      { type: "chunk", delta: "这个转折略显突然。" },
      {
        type: "completed",
        model: "chat-model",
        finishReason: "stop",
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          reasoningTokens: 5,
          totalTokens: 30,
        },
      },
    ]);
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llmProvider)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    chatService = app.get(StorylineChatService);
    lockService = app.get(StorylineLockService);
    storylineService = app.get(StorylineService);
    databaseService = app.get(DatabaseService);
    await databaseService.db.insert(users).values({
      id: 1,
      uniqueName: "storyline_chat_user",
      displayName: "Storyline Chat User",
      password: "hashed-password",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
    await rm(logDirectory, { force: true, recursive: true });
    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("streams an independent chat from the current ten-chapter window", async () => {
    const storylineId = await createTwelveChapterStory(storylineService);
    const session = await chatService.prepare({
      body: {
        chapterNumber: 12,
        topic: "这个转折是否自然？",
      },
      storylineId,
      userId: "1",
    });

    expect(() => lockService.acquireStorylineLock(storylineId)).toThrow(
      StorylineBusyError,
    );

    const events = await collectAsyncIterable(
      session.stream({ signal: new AbortController().signal }),
    );

    expect(events).toEqual([
      {
        type: "reasoning_chunk",
        sequence: 1,
        delta: "先分析人物动机。",
      },
      {
        type: "answer_chunk",
        sequence: 1,
        delta: "这个转折略显突然。",
      },
      { type: "completed" },
    ]);
    expect(() => {
      const release = lockService.acquireStorylineLock(storylineId);
      release();
    }).not.toThrow();
    expect(llmProvider.streamText).toHaveBeenCalledTimes(1);
    const providerRequest = llmProvider.streamText.mock.calls[0]?.[0];
    expect(providerRequest?.systemPrompt).toBe(
      STORY_CHAPTER_CHAT_SYSTEM_PROMPT,
    );
    const prompt = parsePrompt(providerRequest?.userPrompt);
    expect(prompt).toMatchObject({
      currentChapterNumber: 12,
      storyContext: null,
      topic: "这个转折是否自然？",
    });
    expect(prompt.recentChapters).toHaveLength(10);
    expect(prompt.recentChapters[0]).toMatchObject({
      chapterNumber: 3,
      isCurrent: false,
    });
    expect(prompt.recentChapters.at(-1)).toMatchObject({
      chapterNumber: 12,
      isCurrent: true,
    });
    expect(JSON.stringify(prompt)).not.toContain("第 2 章指令");
    await expect(readdir(logDirectory)).resolves.toEqual([]);
  });

  it("rejects invalid chapters and concurrent chat sessions", async () => {
    const storylineId = await createTwelveChapterStory(storylineService);

    await expect(
      chatService.prepare({
        body: { chapterNumber: 12, topic: "   " },
        storylineId,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      chatService.prepare({
        body: { chapterNumber: 13, topic: "讨论结尾。" },
        storylineId,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(StoryChapterNotFoundError);

    const session = await chatService.prepare({
      body: { chapterNumber: 12, topic: "第一次提问。" },
      storylineId,
      userId: "1",
    });
    await expect(
      chatService.prepare({
        body: { chapterNumber: 12, topic: "第二次提问。" },
        storylineId,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(StorylineBusyError);
    session.release();
  });

  it("uses the nearest safe context when the current context is ahead", async () => {
    const created = await storylineService.saveCreatedStoryline({
      userId: "1",
      initialStoryText: "第一章。",
      instruction: "第二章指令。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
    await storylineService.saveAppendedSegment({
      userId: "1",
      storylineId: created.id,
      instruction: "第三章指令。",
      targetLength: 250,
      generatedText: "第三章。",
      model: "story-model",
      elapsedMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
    const segments = await databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, Number(created.id)))
      .orderBy(storylineSegments.orderIndex);
    const chapterTwoSegment = segments.find(
      (segment) => segment.chapterIndex === 2,
    );
    const chapterThreeSegment = segments.find(
      (segment) => segment.chapterIndex === 3,
    );
    if (chapterTwoSegment === undefined || chapterThreeSegment === undefined) {
      throw new Error("Expected chapter segments");
    }

    const chapterTwoContext = createContext([
      String(segments[0]?.id),
      String(chapterTwoSegment.id),
    ]);
    const currentContext = createContext([
      String(segments[0]?.id),
      String(chapterTwoSegment.id),
      String(chapterThreeSegment.id),
    ]);
    await databaseService.db
      .update(storylineSegments)
      .set({
        previousContextJson: serializeStoryContext(chapterTwoContext),
        previousContextOrderIndex: chapterTwoSegment.orderIndex,
      })
      .where(eq(storylineSegments.id, chapterThreeSegment.id));
    await databaseService.db.insert(storylineContexts).values({
      storylineId: Number(created.id),
      contextJson: serializeStoryContext(currentContext),
      extractedThroughOrderIndex: chapterThreeSegment.orderIndex,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const context = await storylineService.buildChapterChatContext({
      chapterNumber: 2,
      storylineId: created.id,
      userId: "1",
    });

    expect(context.storyContext).toEqual(chapterTwoContext);
    expect(context.contextExtractedThroughOrderIndex).toBe(
      chapterTwoSegment.orderIndex,
    );
    expect(context.chapters.map((chapter) => chapter.chapterNumber)).toEqual([
      1, 2,
    ]);
  });

  it("fails reasoning-only responses and releases the storyline lock", async () => {
    const storylineId = await createTwelveChapterStory(storylineService);
    llmProvider.streamText.mockReturnValue(
      createLlmStream([
        { type: "reasoning", delta: "只有思考。" },
        {
          type: "completed",
          model: "chat-model",
          usage: {
            inputTokens: 10,
            outputTokens: 0,
            reasoningTokens: 4,
            totalTokens: 10,
          },
        },
      ]),
    );
    const session = await chatService.prepare({
      body: { chapterNumber: 12, topic: "请分析。" },
      storylineId,
      userId: "1",
    });

    await expect(
      collectAsyncIterable(
        session.stream({ signal: new AbortController().signal }),
      ),
    ).rejects.toBeInstanceOf(StoryChatEmptyResponseError);
    expect(() => {
      const release = lockService.acquireStorylineLock(storylineId);
      release();
    }).not.toThrow();
    await expect(readdir(logDirectory)).resolves.toEqual([]);
  });

  it("rejects oversized chat material before starting the LLM stream", async () => {
    const created = await storylineService.saveCreatedStoryline({
      userId: "1",
      initialStoryText: "长".repeat(20_000),
      instruction: "继续。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });

    await expect(
      chatService.prepare({
        body: { chapterNumber: 2, topic: "请分析。" },
        storylineId: created.id,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(StoryChatContextTooLargeError);
    expect(llmProvider.streamText).not.toHaveBeenCalled();
    expect(() => {
      const release = lockService.acquireStorylineLock(created.id);
      release();
    }).not.toThrow();
  });
});

async function createTwelveChapterStory(
  storylineService: StorylineService,
): Promise<string> {
  const created = await storylineService.saveCreatedStoryline({
    userId: "1",
    initialStoryText: "第 1 章正文。",
    instruction: "第 2 章指令。",
    generatedText: "第 2 章正文。",
    model: "story-model",
    elapsedMs: 1,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  });

  for (let chapter = 3; chapter <= 12; chapter += 1) {
    await storylineService.saveAppendedSegment({
      userId: "1",
      storylineId: created.id,
      instruction: `第 ${chapter} 章指令。`,
      targetLength: 250,
      generatedText: `第 ${chapter} 章正文。`,
      model: "story-model",
      elapsedMs: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
  }

  return created.id;
}

function createLlmProvider(
  events: readonly LlmTextStreamEvent[],
): jest.Mocked<LlmProvider> {
  return {
    generateText: jest.fn<
      Promise<GenerateLlmTextResponse>,
      [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
    >(),
    streamText: jest.fn<
      AsyncIterable<LlmTextStreamEvent>,
      [GenerateLlmTextRequest, LlmStreamOptions]
    >(() => createLlmStream(events)),
  };
}

async function* createLlmStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function collectAsyncIterable(
  iterable: AsyncIterable<StoryChapterChatStreamEvent>,
): Promise<StoryChapterChatStreamEvent[]> {
  const events: StoryChapterChatStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function parsePrompt(value: string | undefined): {
  currentChapterNumber: number;
  recentChapters: {
    chapterNumber: number;
    isCurrent: boolean;
  }[];
  storyContext: unknown;
  topic: string;
} {
  if (value === undefined) {
    throw new Error("Expected chat prompt");
  }

  return JSON.parse(value) as {
    currentChapterNumber: number;
    recentChapters: {
      chapterNumber: number;
      isCurrent: boolean;
    }[];
    storyContext: unknown;
    topic: string;
  };
}

function createContext(sourceSegmentIds: string[]): StoryContextSnapshot {
  return {
    worldFacts: [
      {
        id: "fact_1",
        kind: "event",
        text: "故事正在推进。",
        status: "active",
        visibility: "observable",
        sourceSegmentIds,
      },
    ],
    characters: [],
    currentScene: {
      location: "",
      timeLabel: "",
      presentCharacterIds: [],
      observableFactIds: ["fact_1"],
      sceneStatus: "故事正在推进。",
      sourceSegmentIds,
    },
  };
}
