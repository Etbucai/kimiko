import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { HealthStatusSchema } from "@kimiko/schema";
import request from "supertest";
import type { App } from "supertest/types";
import { configureApp } from "../src/app.config";
import { reloadEnvForTesting } from "../src/env";
import { AppModule } from "./../src/app.module";

describe("AppController (e2e)", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.DATABASE_URL = ":memory:";
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_TIMEOUT_MS;
    reloadEnvForTesting();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it("/ (GET)", () => {
    return request(app.getHttpServer())
      .get("/")
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain("Kimiko server is running");
      });
  });

  it("/health (GET)", () => {
    return request(app.getHttpServer())
      .get("/health")
      .expect(200)
      .expect((response) => {
        const responseBody: unknown = response.body;
        const health = HealthStatusSchema.parse(responseBody);

        expect(health.status).toBe("ok");
        expect(new Date(health.timestamp).toString()).not.toBe("Invalid Date");
      });
  });

  it("allows cross-origin API requests", async () => {
    const origin = "http://localhost:5173";

    await request(app.getHttpServer())
      .get("/health")
      .set("Origin", origin)
      .expect("access-control-allow-origin", origin)
      .expect(200);

    await request(app.getHttpServer())
      .options("/user/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization")
      .expect("access-control-allow-origin", origin)
      .expect("access-control-allow-methods", /POST/)
      .expect("access-control-allow-headers", /authorization/)
      .expect(204);
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });
});
