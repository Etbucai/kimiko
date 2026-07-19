import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { HealthStatusSchema } from "@kimiko/schema";
import request from "supertest";
import type { App } from "supertest/types";
import { AppModule } from "./../src/app.module";

describe("AppController (e2e)", () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

  afterEach(async () => {
    await app.close();
  });
});
