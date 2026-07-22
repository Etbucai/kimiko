import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  LoginUserRequest,
  LoginUserResponse,
  RegisterUserRequest,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import {
  GetRecentStorylineResponseSchema,
  LoginUserResponseSchema,
  GetStorylineSummaryResponseSchema,
  StoryRealtimeServerEventSchema,
} from "@kimiko/schema";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { App } from "supertest/types";
import request from "supertest";
import WebSocket from "ws";
import { configureApp } from "../src/app.config";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmTextStreamEvent,
} from "../src/llm/llm.provider";

describe("RealtimeGateway (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication<App> | undefined;

  beforeEach(() => {
    process.env.DATABASE_URL = ":memory:";
    process.env.LLM_BASE_URL = "";
    process.env.LLM_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.LLM_TIMEOUT_MS = "";
    reloadEnvForTesting();
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }

    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("rejects connections without a token", async () => {
    app = await createApp(createStreamingProvider());

    const closeEvent = await connectAndWaitForClose(getRealtimeUrl(app));

    expect(closeEvent.code).toBe(1008);
  });

  it("streams story events over websocket", async () => {
    const llmProvider = createStreamingProvider();
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "stream_story");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const eventsPromise = readEvents(socket, 5);

    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-1",
        payload: {
          mode: "create",
          initialStoryText: "雨停以后。",
          instruction: "继续调查。",
        },
      }),
    );

    const events = await eventsPromise;

    expect(events.slice(0, 4)).toEqual([
      {
        type: "story.started",
        requestId: "request-1",
      },
      {
        type: "story.chunk",
        requestId: "request-1",
        sequence: 1,
        delta: "林夏",
      },
      {
        type: "story.chunk",
        requestId: "request-1",
        sequence: 2,
        delta: "走向钟楼。",
      },
      {
        type: "story.summary.started",
        requestId: "request-1",
      },
    ]);
    expect(events[4]).toMatchObject({
      type: "story.completed",
      requestId: "request-1",
      generatedSegmentId: expect.stringMatching(/^[1-9]\d*$/) as string,
      storyline: {
        id: expect.stringMatching(/^[1-9]\d*$/) as string,
        segments: [
          {
            id: expect.stringMatching(/^[1-9]\d*$/) as string,
            type: "initial",
            text: "雨停以后。",
          },
          {
            id: expect.stringMatching(/^[1-9]\d*$/) as string,
            type: "generated",
            text: "林夏走向钟楼。",
          },
        ],
        latestGeneration: {
          segmentId: expect.stringMatching(/^[1-9]\d*$/) as string,
          model: "story-model",
          elapsedMs: expect.any(Number) as number,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
          },
        },
        updatedAt: expect.any(String) as string,
      },
    });
    expect(llmProvider.streamText.mock.calls[0]?.[0].systemPrompt).toContain(
      "你是 StoryAgent",
    );
    expect(llmProvider.streamText.mock.calls[0]?.[0].userPrompt).toContain(
      "雨停以后。",
    );
    expect(llmProvider.generateText.mock.calls[0]?.[0].systemPrompt).toContain(
      "角色摘要维护器",
    );
    expect(llmProvider.generateText.mock.calls[0]?.[0].userPrompt).toContain(
      "林夏走向钟楼。",
    );

    const recentResponse = await request(app.getHttpServer())
      .get("/storylines/recent")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const recentStoryline = GetRecentStorylineResponseSchema.parse(
      recentResponse.body as unknown,
    );

    expect(recentStoryline.storyline).toMatchObject({
      id: expect.stringMatching(/^[1-9]\d*$/) as string,
      segments: [
        {
          type: "initial",
          text: "雨停以后。",
        },
        {
          type: "generated",
          text: "林夏走向钟楼。",
        },
      ],
    });
    expect(recentStoryline.storyline).not.toHaveProperty("summary");

    const createdStorylineId = recentStoryline.storyline?.id;
    expect(createdStorylineId).toEqual(expect.stringMatching(/^[1-9]\d*$/));
    const summaryResponse = await request(app.getHttpServer())
      .get(`/storylines/${createdStorylineId}/summary`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const summaryResult = GetStorylineSummaryResponseSchema.parse(
      summaryResponse.body as unknown,
    );

    expect(summaryResult.summary).toEqual({
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "调查旧钟楼的记者",
          relationships: [],
          motivation: "查清钟楼失踪案",
          currentStatus: "正在前往钟楼",
        },
      ],
    });

    socket.close();
  });

  it("returns STORY_SUMMARY_FAILED and does not save the generated story when summary generation fails", async () => {
    const llmProvider = createStreamingProvider({
      summaryText: "not json",
    });
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "summary_failure");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const eventsPromise = readEvents(socket, 5);

    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-1",
        payload: {
          mode: "create",
          initialStoryText: "雨停以后。",
          instruction: "继续调查。",
        },
      }),
    );

    const events = await eventsPromise;

    expect(events[3]).toEqual({
      type: "story.summary.started",
      requestId: "request-1",
    });
    expect(events[4]).toEqual({
      type: "story.error",
      requestId: "request-1",
      code: "STORY_SUMMARY_FAILED",
      message: "生成失败，请稍后重试",
      retryable: true,
    });

    const recentResponse = await request(app.getHttpServer())
      .get("/storylines/recent")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const recentStoryline = GetRecentStorylineResponseSchema.parse(
      recentResponse.body as unknown,
    );

    expect(recentStoryline.storyline).toBeNull();

    socket.close();
  });

  it("returns busy for a second active generation and supports cancel", async () => {
    const llmProvider = createHangingProvider();
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "busy_story");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const initialEventsPromise = readEvents(socket, 2);

    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-1",
        payload: {
          mode: "create",
          initialStoryText: "story",
          instruction: "continue",
        },
      }),
    );
    await initialEventsPromise;

    const busyEventPromise = readEvent(socket);
    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-2",
        payload: {
          mode: "create",
          initialStoryText: "story",
          instruction: "continue",
        },
      }),
    );
    const busyEvent = await busyEventPromise;
    expect(busyEvent).toEqual({
      type: "story.error",
      requestId: "request-2",
      code: "BUSY",
      message: "当前连接已有生成任务",
      retryable: true,
    });

    const cancelledEventPromise = readEvent(socket);
    socket.send(
      JSON.stringify({
        type: "story.cancel",
        requestId: "request-1",
      }),
    );
    const cancelledEvent = await cancelledEventPromise;
    expect(cancelledEvent).toEqual({
      type: "story.cancelled",
      requestId: "request-1",
    });

    socket.close();
  });
});

async function waitOneTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createStreamingProvider(
  options: Readonly<{ summaryText?: string }> = {},
): jest.Mocked<LlmProvider> {
  const llmProvider = createBaseProvider();
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
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      },
    ]),
  );
  llmProvider.generateText.mockResolvedValue({
    text:
      options.summaryText ??
      JSON.stringify({
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "调查旧钟楼的记者",
            relationships: [],
            motivation: "查清钟楼失踪案",
            currentStatus: "正在前往钟楼",
          },
        ],
      }),
    model: "summary-model",
  });

  return llmProvider;
}

function createHangingProvider(): jest.Mocked<LlmProvider> {
  const llmProvider = createBaseProvider();
  llmProvider.streamText.mockImplementation((_input, options) =>
    createHangingStream(options.signal),
  );

  return llmProvider;
}

function createBaseProvider(): jest.Mocked<LlmProvider> {
  return {
    generateText: jest.fn<
      Promise<GenerateLlmTextResponse>,
      [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
    >(),
    streamText: jest.fn<
      AsyncIterable<LlmTextStreamEvent>,
      [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
    >(),
  };
}

async function* createStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function* createHangingStream(
  signal: AbortSignal,
): AsyncIterable<LlmTextStreamEvent> {
  yield {
    type: "chunk",
    delta: "partial",
  };

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function createApp(
  llmProvider: LlmProvider,
): Promise<INestApplication<App>> {
  const moduleBuilder = Test.createTestingModule({
    imports: [AppModule],
  });
  overrideLlmProvider(moduleBuilder, llmProvider);
  const moduleFixture = await moduleBuilder.compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.listen(0);

  return app;
}

function overrideLlmProvider(
  moduleBuilder: TestingModuleBuilder,
  llmProvider: LlmProvider,
): void {
  moduleBuilder.overrideProvider(LLM_PROVIDER).useValue(llmProvider);
}

async function registerAndLogin(
  app: INestApplication<App>,
  uniqueNameSuffix: string,
): Promise<string> {
  const registerBody = {
    uniqueName: `realtime_${uniqueNameSuffix}`,
    displayName: "Realtime User",
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

  const loginResponse = await request(app.getHttpServer())
    .post("/user/login")
    .send(loginBody)
    .expect(201);
  const loginResult: LoginUserResponse = LoginUserResponseSchema.parse(
    loginResponse.body as unknown,
  );

  return loginResult.session.accessToken;
}

function getRealtimeUrl(app: INestApplication<App>): string {
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/realtime`;
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("close", (code) =>
      reject(new Error(`WebSocket closed before open: ${code}`)),
    );
    socket.once("error", (error) => reject(toError(error)));
  });

  return socket;
}

async function connectAndWaitForClose(
  url: string,
): Promise<Readonly<{ code: number; reason: Buffer }>> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("close", (code, reason) => {
      resolve({
        code,
        reason,
      });
    });
    socket.once("error", (error) => reject(toError(error)));
  });
}

async function readEvents(
  socket: WebSocket,
  count: number,
): Promise<StoryRealtimeServerEvent[]> {
  if (socket.readyState === WebSocket.CLOSED) {
    throw new Error("WebSocket is already closed");
  }

  return new Promise((resolve, reject) => {
    const events: StoryRealtimeServerEvent[] = [];
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };
    const handleMessage = (data: WebSocket.RawData) => {
      try {
        events.push(parseRealtimeEvent(data));
        if (events.length === count) {
          cleanup();
          resolve(events);
        }
      } catch (error: unknown) {
        cleanup();
        reject(toError(error));
      }
    };
    const handleClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed before messages: ${code}`));
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(toError(error));
    };

    socket.on("message", handleMessage);
    socket.once("close", handleClose);
    socket.once("error", handleError);
  });
}

async function readEvent(socket: WebSocket): Promise<StoryRealtimeServerEvent> {
  if (socket.readyState === WebSocket.CLOSED) {
    throw new Error("WebSocket is already closed");
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("close", handleClose);
      socket.off("error", handleError);
    };
    const handleClose = (code: number) => {
      cleanup();
      reject(new Error(`WebSocket closed before message: ${code}`));
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(toError(error));
    };

    socket.once("message", (data) => {
      try {
        cleanup();
        resolve(parseRealtimeEvent(data));
      } catch (error: unknown) {
        reject(toError(error));
      }
    });
    socket.once("close", handleClose);
    socket.once("error", handleError);
  });
}

function parseRealtimeEvent(data: WebSocket.RawData): StoryRealtimeServerEvent {
  return StoryRealtimeServerEventSchema.parse(JSON.parse(rawDataToString(data)));
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
