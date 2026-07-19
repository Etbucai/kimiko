import type { INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type {
  LoginUserRequest,
  RefreshTokenRequest,
  RegisterUserRequest,
} from "@kimiko/schema";
import {
  GetMyUserInfoResponseSchema,
  LoginUserResponseSchema,
  RefreshTokenResponseSchema,
  RegisterUserResponseSchema,
  TokenType,
} from "@kimiko/schema";
import request from "supertest";
import type { App } from "supertest/types";
import { AppModule } from "../src/app.module";
import { reloadEnvForTesting } from "../src/env";

describe("UserController (e2e)", () => {
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("registers, logs in, authenticates, refreshes, and logs out", async () => {
    const registerBody = {
      uniqueName: "kimiko_user",
      displayName: "Kimiko User",
      password: "password123",
    } satisfies RegisterUserRequest;

    const registerResponse = await request(app.getHttpServer())
      .post("/user/register")
      .send(registerBody)
      .expect(201);
    const registeredUser = RegisterUserResponseSchema.parse(
      registerResponse.body as unknown,
    );

    expect(registeredUser.userId).toMatch(/^[1-9]\d*$/);

    await request(app.getHttpServer())
      .post("/user/register")
      .send(registerBody)
      .expect(409);

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

    expect(loginResult.session.userId).toBe(registeredUser.userId);
    expect(loginResult.session.tokenType).toBe(TokenType.Bearer);
    expect(loginResult.me).toMatchObject({
      userId: registeredUser.userId,
      uniqueName: registerBody.uniqueName,
      displayName: registerBody.displayName,
      avatarUrl: "",
    });

    const meResponse = await request(app.getHttpServer())
      .post("/user/me")
      .set("Authorization", `Bearer ${loginResult.session.accessToken}`)
      .expect(201);
    const me = GetMyUserInfoResponseSchema.parse(meResponse.body as unknown);

    expect(me).toEqual(loginResult.me);

    const refreshBody = {
      refreshToken: loginResult.session.refreshToken,
    } satisfies RefreshTokenRequest;

    const refreshResponse = await request(app.getHttpServer())
      .post("/user/refresh")
      .send(refreshBody)
      .expect(201);
    const refreshResult = RefreshTokenResponseSchema.parse(
      refreshResponse.body as unknown,
    );

    expect(refreshResult.session.userId).toBe(registeredUser.userId);
    expect(refreshResult.session.refreshToken).not.toBe(
      loginResult.session.refreshToken,
    );

    await request(app.getHttpServer())
      .post("/user/refresh")
      .send(refreshBody)
      .expect(401);

    await request(app.getHttpServer())
      .post("/user/logout")
      .set("Authorization", `Bearer ${refreshResult.session.accessToken}`)
      .send({
        refreshToken: refreshResult.session.refreshToken,
      } satisfies RefreshTokenRequest)
      .expect(201);

    await request(app.getHttpServer())
      .post("/user/refresh")
      .send({
        refreshToken: refreshResult.session.refreshToken,
      } satisfies RefreshTokenRequest)
      .expect(401);
  });

  it("rejects missing or invalid credentials", async () => {
    await request(app.getHttpServer()).post("/user/me").expect(401);

    await request(app.getHttpServer())
      .post("/user/register")
      .send({
        uniqueName: "ab",
        displayName: "Invalid",
        password: "password123",
      } satisfies RegisterUserRequest)
      .expect(400);

    await request(app.getHttpServer())
      .post("/user/login")
      .send({
        uniqueName: "missing_user",
        password: "password123",
      } satisfies LoginUserRequest)
      .expect(401);
  });
});
