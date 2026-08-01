import type { INestApplication } from "@nestjs/common";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  LoginUserRequest,
  LoginUserResponse,
  RegisterUserRequest,
  StoryChapterChatStreamEvent,
} from "@kimiko/schema";
import {
  LoginUserResponseSchema,
  StoryChapterChatStreamEventSchema,
} from "@kimiko/schema";
import { Test } from "@nestjs/testing";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { App } from "supertest/types";
import { configureApp } from "../src/app.config";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamOptions,
  type LlmTextStreamEvent,
} from "../src/llm/llm.provider";
import { StorylineLockService } from "../src/storyline/storyline-lock.service";
import { StorylineService } from "../src/storyline/storyline.service";

describe("Storyline chapter chat (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication<App> | undefined;
  let llmProvider: jest.Mocked<LlmProvider>;
  let logDirectory: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.LLM_BASE_URL = "";
    process.env.LLM_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.LLM_TIMEOUT_MS = "";
    logDirectory = await mkdtemp(join(tmpdir(), "kimiko-chat-e2e-log-"));
    process.env.KIMIKO_LLM_CALL_LOG_DIR = logDirectory;
    reloadEnvForTesting();

    llmProvider = createProvider([
      { type: "reasoning", delta: "先检查前文。" },
      { type: "chunk", delta: "这个转折需要更多铺垫。" },
      {
        type: "completed",
        model: "chat-model",
        usage: {
          inputTokens: 30,
          outputTokens: 10,
          reasoningTokens: 5,
          totalTokens: 40,
        },
      },
    ]);
    app = await createApp(llmProvider);
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

  it("authenticates and streams a read-only historical chapter chat", async () => {
    if (app === undefined) {
      throw new Error("Expected app");
    }
    const auth = await registerAndLogin(app, "historical");
    const storylineService = app.get(StorylineService);
    const storylineId = await createTwelveChapterStory(
      storylineService,
      auth.userId,
    );
    const before = await storylineService.getStorylineSnapshotForUser(
      auth.userId,
      storylineId,
      { anchorPage: 12, before: 3, after: 0 },
    );

    const response = await request(app.getHttpServer())
      .post(`/storylines/${storylineId}/chat/stream`)
      .set("Accept", "application/x-ndjson")
      .set("Authorization", `Bearer ${auth.accessToken}`)
      .send({
        chapterNumber: 12,
        topic: "这个转折是否自然？",
      })
      .expect(200)
      .expect("Content-Type", /application\/x-ndjson/);

    expect(parseNdjson(response.text)).toEqual([
      { type: "started" },
      {
        type: "reasoning_chunk",
        sequence: 1,
        delta: "先检查前文。",
      },
      {
        type: "answer_chunk",
        sequence: 1,
        delta: "这个转折需要更多铺垫。",
      },
      { type: "completed" },
    ]);
    const prompt = parsePrompt(
      llmProvider.streamText.mock.calls[0]?.[0].userPrompt,
    );
    expect(prompt.currentChapterNumber).toBe(12);
    expect(prompt.recentChapters).toHaveLength(10);
    expect(prompt.recentChapters[0]?.chapterNumber).toBe(3);
    expect(prompt.recentChapters.at(-1)?.chapterNumber).toBe(12);
    expect(prompt.topic).toBe("这个转折是否自然？");

    const after = await storylineService.getStorylineSnapshotForUser(
      auth.userId,
      storylineId,
      { anchorPage: 12, before: 3, after: 0 },
    );
    expect(after).toEqual(before);
    await expect(readdir(logDirectory)).resolves.toEqual([]);
  });

  it("rejects unauthenticated, unavailable, and busy requests before streaming", async () => {
    if (app === undefined) {
      throw new Error("Expected app");
    }
    await request(app.getHttpServer())
      .post("/storylines/1/chat/stream")
      .send({ chapterNumber: 1, topic: "讨论。" })
      .expect(401);

    const auth = await registerAndLogin(app, "errors");
    const storylineService = app.get(StorylineService);
    const storylineId = await createTwelveChapterStory(
      storylineService,
      auth.userId,
    );

    await request(app.getHttpServer())
      .post(`/storylines/${storylineId}/chat/stream`)
      .set("Authorization", `Bearer ${auth.accessToken}`)
      .send({ chapterNumber: 13, topic: "讨论。" })
      .expect(404);

    const release = app
      .get(StorylineLockService)
      .acquireStorylineLock(storylineId);
    try {
      await request(app.getHttpServer())
        .post(`/storylines/${storylineId}/chat/stream`)
        .set("Authorization", `Bearer ${auth.accessToken}`)
        .send({ chapterNumber: 12, topic: "讨论。" })
        .expect(409);
    } finally {
      release();
    }

    expect(llmProvider.streamText).not.toHaveBeenCalled();
  });
});

async function createApp(
  provider: LlmProvider,
): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_PROVIDER)
    .useValue(provider)
    .compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.listen(0);
  return app;
}

async function registerAndLogin(
  app: INestApplication<App>,
  suffix: string,
): Promise<Readonly<{ accessToken: string; userId: string }>> {
  const registerBody = {
    uniqueName: `story_chat_${suffix}`,
    displayName: "Story Chat User",
    password: "password123",
  } satisfies RegisterUserRequest;
  await request(app.getHttpServer())
    .post("/user/register")
    .send(registerBody)
    .expect(201);

  const loginBody = {
    uniqueName: registerBody.uniqueName,
    password: registerBody.password,
  } satisfies LoginUserRequest;
  const response = await request(app.getHttpServer())
    .post("/user/login")
    .send(loginBody)
    .expect(201);
  const result: LoginUserResponse = LoginUserResponseSchema.parse(
    response.body as unknown,
  );
  return {
    accessToken: result.session.accessToken,
    userId: result.session.userId,
  };
}

async function createTwelveChapterStory(
  storylineService: StorylineService,
  userId: string,
): Promise<string> {
  const created = await storylineService.saveCreatedStoryline({
    userId,
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
      userId,
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

function createProvider(
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
    >(() => createStream(events)),
  };
}

async function* createStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function parseNdjson(value: string): StoryChapterChatStreamEvent[] {
  return value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      StoryChapterChatStreamEventSchema.parse(JSON.parse(line) as unknown),
    );
}

function parsePrompt(value: string | undefined): {
  currentChapterNumber: number;
  recentChapters: { chapterNumber: number }[];
  topic: string;
} {
  if (value === undefined) {
    throw new Error("Expected chat prompt");
  }
  return JSON.parse(value) as {
    currentChapterNumber: number;
    recentChapters: { chapterNumber: number }[];
    topic: string;
  };
}
