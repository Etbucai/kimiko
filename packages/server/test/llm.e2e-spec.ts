import type { INestApplication } from "@nestjs/common";
import { ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type {
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  GenerateLlmTextStreamEvent,
  LoginUserRequest,
  RegisterUserRequest,
} from "@kimiko/schema";
import {
  GenerateLlmTextResponseSchema,
  GenerateLlmTextStreamEventSchema,
  LoginUserResponseSchema,
} from "@kimiko/schema";
import request from "supertest";
import type { App } from "supertest/types";
import { configureApp } from "../src/app.config";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmTextStreamEvent,
} from "../src/llm/llm.provider";

describe("LlmController (e2e)", () => {
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

  it("requires authentication", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .post("/llm/generate")
      .send({
        userPrompt: "hello",
      } satisfies GenerateLlmTextRequest)
      .expect(401);
  });

  it("returns 503 when the LLM provider is not configured", async () => {
    app = await createApp();
    const accessToken = await registerAndLogin(app, "unconfigured");

    await request(app.getHttpServer())
      .post("/llm/generate")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        userPrompt: "hello",
      } satisfies GenerateLlmTextRequest)
      .expect(503);
  });

  it("generates text through the configured provider", async () => {
    const llmProvider: jest.Mocked<LlmProvider> = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
      >(),
      streamText: jest.fn<
        AsyncIterable<LlmTextStreamEvent>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
      >(),
    };
    llmProvider.generateText.mockResolvedValue({
      text: "answer",
      model: "default-model",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });

    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "configured");

    const response = await request(app.getHttpServer())
      .post("/llm/generate")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        userPrompt: "  hello  ",
        systemPrompt: "  be concise  ",
      } satisfies GenerateLlmTextRequest)
      .expect(200);
    const result = GenerateLlmTextResponseSchema.parse(
      response.body as unknown,
    );

    expect(result).toEqual({
      text: "answer",
      model: "default-model",
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });
    expect(llmProvider.generateText.mock.calls[0]?.[0]).toEqual({
      userPrompt: "hello",
      systemPrompt: "be concise",
    });
  });

  it("keeps provider failures mapped to HTTP errors", async () => {
    const llmProvider: LlmProvider = {
      async generateText(): Promise<never> {
        throw new ServiceUnavailableException("LLM provider is unavailable");
      },
      streamText(): AsyncIterable<never> {
        return createFailingStream(
          new ServiceUnavailableException("LLM provider is unavailable"),
        );
      },
    };

    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "provider_failure");

    await request(app.getHttpServer())
      .post("/llm/generate")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        userPrompt: "hello",
      } satisfies GenerateLlmTextRequest)
      .expect(503);
  });

  it("streams NDJSON events through the configured provider", async () => {
    const llmProvider: jest.Mocked<LlmProvider> = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>?]
      >(),
      streamText: jest.fn<
        AsyncIterable<LlmTextStreamEvent>,
        [GenerateLlmTextRequest, Readonly<{ signal: AbortSignal }>]
      >(),
    };
    llmProvider.streamText.mockReturnValue(
      createEventStream([
        { type: "chunk", delta: "hello" },
        {
          type: "completed",
          model: "default-model",
          finishReason: "stop",
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            totalTokens: 7,
          },
        },
      ]),
    );

    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "configured_stream");

    const response = await request(app.getHttpServer())
      .post("/llm/generate/stream")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", "application/x-ndjson")
      .send({
        userPrompt: "  hello  ",
        systemPrompt: "  be concise  ",
      } satisfies GenerateLlmTextRequest)
      .expect(200);

    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(parseNdjsonEvents(response.text)).toEqual([
      {
        type: "started",
      },
      {
        type: "chunk",
        sequence: 1,
        delta: "hello",
      },
      {
        type: "completed",
        model: "default-model",
        finishReason: "stop",
        elapsedMs: expect.any(Number),
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
        },
      },
    ]);
    expect(llmProvider.streamText.mock.calls[0]?.[0]).toEqual({
      userPrompt: "hello",
      systemPrompt: "be concise",
    });
  });
});

async function createApp(
  llmProvider?: LlmProvider,
): Promise<INestApplication<App>> {
  const moduleBuilder = Test.createTestingModule({
    imports: [AppModule],
  });

  if (llmProvider !== undefined) {
    overrideLlmProvider(moduleBuilder, llmProvider);
  }

  const moduleFixture = await moduleBuilder.compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();

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
    uniqueName: `llm_${uniqueNameSuffix}`,
    displayName: "LLM User",
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
  const loginResult = LoginUserResponseSchema.parse(
    loginResponse.body as unknown,
  );

  return loginResult.session.accessToken;
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

function createEventStream(
  events: readonly LlmTextStreamEvent[],
): AsyncIterable<LlmTextStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<LlmTextStreamEvent> {
      let index = 0;

      return {
        async next(): Promise<IteratorResult<LlmTextStreamEvent>> {
          const event = events[index];
          if (event === undefined) {
            return {
              done: true,
              value: undefined,
            };
          }

          index += 1;
          return {
            done: false,
            value: event,
          };
        },
      };
    },
  };
}

function parseNdjsonEvents(text: string): GenerateLlmTextStreamEvent[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => GenerateLlmTextStreamEventSchema.parse(JSON.parse(line)));
}
