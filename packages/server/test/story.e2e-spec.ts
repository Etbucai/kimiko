import type { INestApplication } from "@nestjs/common";
import { ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type {
  ContinueStoryRequest,
  GenerateLlmTextRequest,
  GenerateLlmTextResponse,
  LoginUserRequest,
  RegisterUserRequest,
} from "@kimiko/schema";
import {
  ContinueStoryResponseSchema,
  LoginUserResponseSchema,
} from "@kimiko/schema";
import request from "supertest";
import type { App } from "supertest/types";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";
import { LLM_PROVIDER, type LlmProvider } from "../src/llm/llm.provider";

describe("StoryController (e2e)", () => {
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
      .post("/story/continue")
      .send({
        storyText: "story",
        instruction: "continue",
      } satisfies ContinueStoryRequest)
      .expect(401);
  });

  it("rejects invalid request bodies", async () => {
    app = await createApp(createSuccessfulProvider());
    const accessToken = await registerAndLogin(app, "invalid_story");

    await request(app.getHttpServer())
      .post("/story/continue")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        storyText: "   ",
        instruction: "continue",
      })
      .expect(400);
  });

  it("continues a story through the configured provider", async () => {
    const llmProvider = createSuccessfulProvider();
    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "configured_story");

    const response = await request(app.getHttpServer())
      .post("/story/continue")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        storyText: "  雨停以后，林夏站在旧书店门口。  ",
        instruction: "  林夏前往钟楼调查。  ",
      } satisfies ContinueStoryRequest)
      .expect(200);
    const result = ContinueStoryResponseSchema.parse(
      response.body as unknown,
    );

    expect(result).toEqual({
      continuedStory: "林夏继续走向钟楼。",
      model: "story-model",
      elapsedMs: expect.any(Number) as number,
      usage: {
        inputTokens: 30,
        outputTokens: 70,
        totalTokens: 100,
      },
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const providerInput = llmProvider.generateText.mock.calls[0]?.[0];
    expect(providerInput?.systemPrompt).toContain("你是 StoryAgent");
    expect(providerInput?.systemPrompt).toContain("800-1200 字");
    expect(providerInput?.userPrompt).toContain(
      "故事正文：\n雨停以后，林夏站在旧书店门口。",
    );
    expect(providerInput?.userPrompt).toContain(
      "续写指令：\n林夏前往钟楼调查。",
    );
  });

  it("returns 503 when the LLM provider is not configured", async () => {
    app = await createApp();
    const accessToken = await registerAndLogin(app, "unconfigured_story");

    await request(app.getHttpServer())
      .post("/story/continue")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        storyText: "story",
        instruction: "continue",
      } satisfies ContinueStoryRequest)
      .expect(503);
  });

  it("returns 502 when the provider omits token usage", async () => {
    const llmProvider: jest.Mocked<LlmProvider> = {
      generateText: jest.fn<
        Promise<GenerateLlmTextResponse>,
        [GenerateLlmTextRequest]
      >(),
    };
    llmProvider.generateText.mockResolvedValue({
      text: "continued story",
      model: "story-model",
    });

    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "missing_usage_story");

    await request(app.getHttpServer())
      .post("/story/continue")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        storyText: "story",
        instruction: "continue",
      } satisfies ContinueStoryRequest)
      .expect(502);
  });

  it("keeps provider failures mapped to HTTP errors", async () => {
    const llmProvider: LlmProvider = {
      async generateText(): Promise<never> {
        throw new ServiceUnavailableException("LLM provider is unavailable");
      },
    };

    app = await createApp(llmProvider);
    const accessToken = await registerAndLogin(app, "provider_failure_story");

    await request(app.getHttpServer())
      .post("/story/continue")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        storyText: "story",
        instruction: "continue",
      } satisfies ContinueStoryRequest)
      .expect(503);
  });
});

function createSuccessfulProvider(): jest.Mocked<LlmProvider> {
  const llmProvider: jest.Mocked<LlmProvider> = {
    generateText: jest.fn<
      Promise<GenerateLlmTextResponse>,
      [GenerateLlmTextRequest]
    >(),
  };
  llmProvider.generateText.mockResolvedValue({
    text: "  林夏继续走向钟楼。  ",
    model: "story-model",
    usage: {
      inputTokens: 30,
      outputTokens: 70,
      totalTokens: 100,
    },
  });

  return llmProvider;
}

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
    uniqueName: `story_${uniqueNameSuffix}`,
    displayName: "Story User",
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
