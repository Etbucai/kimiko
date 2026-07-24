import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  LoginUserRequest,
  LoginUserResponse,
  RegisterUserRequest,
  StoryGenerationStatusResponse,
  StoryCompletedServerEvent,
  StoryRealtimeServerEvent,
} from "@kimiko/schema";
import {
  CancelStoryGenerationResponseSchema,
  GetStorylineContextResponseSchema,
  GetRecentStorylineResponseSchema,
  GetStorylineResponseSchema,
  LoginUserResponseSchema,
  ListStorylinesResponseSchema,
  StoryGenerationStatusResponseSchema,
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
        type: "story.context.started",
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
      "故事上下文增量维护器",
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
    const contextResponse = await request(app.getHttpServer())
      .get(`/storylines/${createdStorylineId}/context`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const contextResult = GetStorylineContextResponseSchema.parse(
      contextResponse.body as unknown,
    );

    expect(contextResult.context?.characters[0]).toMatchObject({
      id: "char_1",
      name: "林夏",
      identity: "调查旧钟楼的记者",
    });

    socket.close();
  });

  it("lists storylines as lightweight cards and opens a selected storyline", async () => {
    const llmProvider = createStreamingProvider();
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "storyline_list");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const firstStoryline = await createStorylineOverSocket(socket, {
      requestId: "request-1",
      initialStoryText: "第一条故事的开场。\n这是第二行。",
      instruction: "继续第一条。",
    });
    const secondStoryline = await createStorylineOverSocket(socket, {
      requestId: "request-2",
      initialStoryText: "第二条故事的开场。",
      instruction: "继续第二条。",
    });

    const listResponse = await request(app.getHttpServer())
      .get("/storylines")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const listResult = ListStorylinesResponseSchema.parse(
      listResponse.body as unknown,
    );

    expect(listResult.storylines).toEqual([
      {
        id: secondStoryline.storyline.id,
        title: "第二条故事的开场。",
        preview: "林夏走向钟楼。",
        updatedAt: secondStoryline.storyline.updatedAt,
        segmentCount: 2,
        chapterCount: 2,
      },
      {
        id: firstStoryline.storyline.id,
        title: "第一条故事的开场。",
        preview: "林夏走向钟楼。",
        updatedAt: firstStoryline.storyline.updatedAt,
        segmentCount: 2,
        chapterCount: 2,
      },
    ]);
    expect(listResult.storylines[0]).not.toHaveProperty("segments");

    const detailResponse = await request(app.getHttpServer())
      .get(`/storylines/${secondStoryline.storyline.id}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const detailResult = GetStorylineResponseSchema.parse(
      detailResponse.body as unknown,
    );

    expect(detailResult.storyline).toEqual(secondStoryline.storyline);

    socket.close();
  });

  it("returns empty lists and 404 for missing storyline HTTP endpoints", async () => {
    app = await createApp(createStreamingProvider());
    const accessToken = await registerAndLogin(app, "storyline_not_found");

    const listResponse = await request(app.getHttpServer())
      .get("/storylines")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const listResult = ListStorylinesResponseSchema.parse(
      listResponse.body as unknown,
    );

    expect(listResult.storylines).toEqual([]);

    await request(app.getHttpServer())
      .get("/storylines/not-a-storyline")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get("/storylines/999999/context")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(404);
  });

  it("returns STORY_CONTEXT_FAILED and does not save the generated story when context generation fails", async () => {
    const llmProvider = createStreamingProvider({
      contextText: "not json",
    });
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "context_failure");
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
      type: "story.context.started",
      requestId: "request-1",
    });
    expect(events[4]).toEqual({
      type: "story.error",
      requestId: "request-1",
      code: "STORY_CONTEXT_FAILED",
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

  it("continues an existing storyline generation after websocket disconnect and exposes status", async () => {
    const controlledProvider = createControlledProvider();
    app = await createApp(controlledProvider.provider);
    const runningApp = app;
    const accessToken = await registerAndLogin(app, "background_continue");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const createdStoryline = await createStorylineOverSocket(socket, {
      requestId: "request-create",
      initialStoryText: "雨停以后。",
      instruction: "继续调查。",
    });
    controlledProvider.resetForHangingStream({
      contextText: createAppendContextPatchText(),
    });

    const eventsPromise = readEvents(socket, 2);
    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-append",
        payload: {
          mode: "append",
          storylineId: createdStoryline.storyline.id,
          instruction: "继续追踪。",
          targetLength: 750,
        },
      }),
    );
    await eventsPromise;
    socket.close();
    await waitOneTick();

    const runningStatus = await getGenerationStatus(
      runningApp,
      accessToken,
      createdStoryline.storyline.id,
    );
    expect(runningStatus.task).toMatchObject({
      status: "running",
      phase: "streaming",
      mode: "append",
      requestId: "request-append",
      storylineId: createdStoryline.storyline.id,
    });

    controlledProvider.completeHangingStream();
    await waitForCondition(async () => {
      const status = await getGenerationStatus(
        runningApp,
        accessToken,
        createdStoryline.storyline.id,
      );
      return status.task?.status === "completed";
    });
    const completedStatus = await getGenerationStatus(
      runningApp,
      accessToken,
      createdStoryline.storyline.id,
    );
    expect(completedStatus.task).toMatchObject({
      status: "completed",
      generatedSegmentId: expect.stringMatching(/^[1-9]\d*$/) as string,
    });

    const detailResponse = await request(app.getHttpServer())
      .get(`/storylines/${createdStoryline.storyline.id}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const detailResult = GetStorylineResponseSchema.parse(
      detailResponse.body as unknown,
    );
    expect(detailResult.storyline.segments.at(-1)).toMatchObject({
      type: "generated",
      text: "林夏走向钟楼。",
    });
  });

  it("cancels an existing storyline background generation through REST", async () => {
    const controlledProvider = createControlledProvider();
    app = await createApp(controlledProvider.provider);
    const accessToken = await registerAndLogin(app, "background_cancel");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const createdStoryline = await createStorylineOverSocket(socket, {
      requestId: "request-create",
      initialStoryText: "雨停以后。",
      instruction: "继续调查。",
    });
    controlledProvider.resetForHangingStream({
      contextText: createAppendContextPatchText(),
    });

    const eventsPromise = readEvents(socket, 2);
    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-append",
        payload: {
          mode: "append",
          storylineId: createdStoryline.storyline.id,
          instruction: "继续追踪。",
          targetLength: 750,
        },
      }),
    );
    await eventsPromise;
    socket.close();
    await waitOneTick();

    const cancelResponse = await request(app.getHttpServer())
      .post(`/storylines/${createdStoryline.storyline.id}/generation/cancel`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(201);
    const cancelResult = CancelStoryGenerationResponseSchema.parse(
      cancelResponse.body as unknown,
    );
    expect(cancelResult).toMatchObject({
      cancelled: true,
      task: {
        status: "cancelled",
        mode: "append",
        requestId: "request-append",
        storylineId: createdStoryline.storyline.id,
      },
    });

    const status = await getGenerationStatus(
      app,
      accessToken,
      createdStoryline.storyline.id,
    );
    expect(status.task).toMatchObject({
      status: "cancelled",
    });
  });

  it("returns STORYLINE_BUSY when another connection starts the same storyline", async () => {
    const controlledProvider = createControlledProvider();
    app = await createApp(controlledProvider.provider);
    const accessToken = await registerAndLogin(app, "background_busy");
    const firstSocket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();

    const createdStoryline = await createStorylineOverSocket(firstSocket, {
      requestId: "request-create",
      initialStoryText: "雨停以后。",
      instruction: "继续调查。",
    });
    controlledProvider.resetForHangingStream({
      contextText: createAppendContextPatchText(),
    });

    const eventsPromise = readEvents(firstSocket, 2);
    firstSocket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-append",
        payload: {
          mode: "append",
          storylineId: createdStoryline.storyline.id,
          instruction: "继续追踪。",
          targetLength: 750,
        },
      }),
    );
    await eventsPromise;

    const secondSocket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    const busyEventPromise = readEvent(secondSocket);
    secondSocket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-second",
        payload: {
          mode: "append",
          storylineId: createdStoryline.storyline.id,
          instruction: "再次续写。",
          targetLength: 500,
        },
      }),
    );
    const busyEvent = await busyEventPromise;

    expect(busyEvent).toEqual({
      type: "story.error",
      requestId: "request-second",
      code: "STORYLINE_BUSY",
      message: "当前故事线正在生成，请稍后重试",
      retryable: true,
    });
    firstSocket.close();
    secondSocket.close();
  });

  it("continues create generation after websocket disconnect without exposing storyline status", async () => {
    const controlledProvider = createControlledProvider();
    app = await createApp(controlledProvider.provider);
    const runningApp = app;
    const accessToken = await registerAndLogin(app, "background_create");
    const socket = await connectWebSocket(
      `${getRealtimeUrl(app)}?accessToken=${accessToken}`,
    );
    await waitOneTick();
    controlledProvider.resetForHangingStream();

    const eventsPromise = readEvents(socket, 2);
    socket.send(
      JSON.stringify({
        type: "story.continue",
        requestId: "request-create",
        payload: {
          mode: "create",
          initialStoryText: "雨停以后。",
          instruction: "继续调查。",
        },
      }),
    );
    await eventsPromise;
    socket.close();
    await waitOneTick();

    controlledProvider.completeHangingStream();
    await waitForCondition(async () => {
      const recentResponse = await request(runningApp.getHttpServer())
        .get("/storylines/recent")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      const recent = GetRecentStorylineResponseSchema.parse(
        recentResponse.body as unknown,
      );
      return recent.storyline !== null;
    });

    const recentResponse = await request(app.getHttpServer())
      .get("/storylines/recent")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    const recent = GetRecentStorylineResponseSchema.parse(
      recentResponse.body as unknown,
    );
    expect(recent.storyline).not.toBeNull();
    const status = await getGenerationStatus(
      app,
      accessToken,
      recent.storyline?.id ?? "",
    );
    expect(status.task).toBeNull();
  });
});

async function waitOneTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error("Timed out waiting for condition");
}

async function getGenerationStatus(
  app: INestApplication<App>,
  accessToken: string,
  storylineId: string,
): Promise<StoryGenerationStatusResponse> {
  const response = await request(app.getHttpServer())
    .get(`/storylines/${storylineId}/generation/status`)
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  return StoryGenerationStatusResponseSchema.parse(response.body as unknown);
}

async function createStorylineOverSocket(
  socket: WebSocket,
  input: Readonly<{
    requestId: string;
    initialStoryText: string;
    instruction: string;
  }>,
): Promise<StoryCompletedServerEvent> {
  const eventsPromise = readEvents(socket, 5);

  socket.send(
    JSON.stringify({
      type: "story.continue",
      requestId: input.requestId,
      payload: {
        mode: "create",
        initialStoryText: input.initialStoryText,
        instruction: input.instruction,
      },
    }),
  );

  return getCompletedEvent(await eventsPromise);
}

function getCompletedEvent(
  events: readonly StoryRealtimeServerEvent[],
): StoryCompletedServerEvent {
  const completedEvent = events.find(
    (event): event is StoryCompletedServerEvent =>
      event.type === "story.completed",
  );
  if (completedEvent === undefined) {
    throw new Error("Storyline creation did not complete");
  }

  return completedEvent;
}

function createStreamingProvider(
  options: Readonly<{ contextText?: string }> = {},
): jest.Mocked<LlmProvider> {
  const llmProvider = createBaseProvider();
  llmProvider.streamText.mockImplementation(() =>
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
      options.contextText ??
      JSON.stringify({
        defaultSourceRefs: ["current"],
        worldFacts: {
          add: [
            {
              draftKey: "main_fact",
              kind: "event",
              text: "林夏走向钟楼。",
              status: "active",
              visibility: "observable",
            },
          ],
          update: [],
          resolve: [],
        },
        characters: {
          add: [
            {
              draftKey: "lin_xia",
              name: "林夏",
              aliases: [],
              identity: "调查旧钟楼的记者",
              traits: [],
              relationshipsAdded: [],
              motivations: ["查清钟楼失踪案"],
              currentStatus: "正在前往钟楼",
              beliefsAdded: [
                {
                  text: "她正在前往钟楼。",
                  truthStatus: "true",
                  factRefs: ["main_fact"],
                },
              ],
              opinionsAdded: [],
              actionTendenciesAdded: [],
            },
          ],
          update: [],
        },
        currentScene: {
          location: "钟楼附近",
          timeLabel: "雨后",
          presentCharacterRefs: ["lin_xia"],
          observableFactRefs: ["main_fact"],
          sceneStatus: "林夏走向钟楼。",
        },
      }),
    model: "context-model",
  });

  return llmProvider;
}

function createAppendContextPatchText(): string {
  return JSON.stringify({
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [
        {
          draftKey: "main_fact",
          kind: "event",
          text: "林夏走向钟楼。",
          status: "active",
          visibility: "observable",
        },
      ],
      update: [],
      resolve: [],
    },
    characters: {
      add: [],
      update: [
        {
          existingId: "char_1",
          currentStatus: "正在前往钟楼",
          beliefsAdded: [
            {
              text: "她正在前往钟楼。",
              truthStatus: "true",
              factRefs: ["main_fact"],
            },
          ],
        },
      ],
    },
    currentScene: {
      location: "钟楼附近",
      timeLabel: "雨后",
      presentCharacterRefs: ["char_1"],
      observableFactRefs: ["main_fact"],
      sceneStatus: "林夏走向钟楼。",
    },
  });
}

function createHangingProvider(): jest.Mocked<LlmProvider> {
  const llmProvider = createBaseProvider();
  llmProvider.streamText.mockImplementation((_input, options) =>
    createHangingStream(options.signal),
  );

  return llmProvider;
}

interface ControlledProvider {
  readonly provider: jest.Mocked<LlmProvider>;
  completeHangingStream: () => void;
  resetForHangingStream: (options?: Readonly<{ contextText?: string }>) => void;
}

function createControlledProvider(): ControlledProvider {
  const llmProvider = createStreamingProvider();
  let completeStream: (() => void) | null = null;

  return {
    provider: llmProvider,
    completeHangingStream() {
      completeStream?.();
      completeStream = null;
    },
    resetForHangingStream(options = {}) {
      completeStream = null;
      if (options.contextText !== undefined) {
        llmProvider.generateText.mockResolvedValue({
          text: options.contextText,
          model: "context-model",
        });
      }
      llmProvider.streamText.mockImplementation((_input, options) =>
        createControlledStream(options.signal, (complete) => {
          completeStream = complete;
        }),
      );
    },
  };
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

async function* createControlledStream(
  signal: AbortSignal,
  onReady: (complete: () => void) => void,
): AsyncIterable<LlmTextStreamEvent> {
  yield {
    type: "chunk",
    delta: "林夏",
  };

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    onReady(resolve);
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

  if (signal.aborted) {
    return;
  }

  yield {
    type: "chunk",
    delta: "走向钟楼。",
  };
  yield {
    type: "completed",
    model: "story-model",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    },
  };
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
  return StoryRealtimeServerEventSchema.parse(
    JSON.parse(rawDataToString(data)),
  );
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
