import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { App } from "supertest/types";
import { configureApp } from "../src/app.config";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";

describe("Story legacy HTTP endpoint (e2e)", () => {
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

  it("does not expose the removed non-streaming continue endpoint", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .post("/story/continue")
      .send({
        storyText: "story",
        instruction: "continue",
      })
      .expect(404);
  });
});

async function createApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();

  return app;
}
