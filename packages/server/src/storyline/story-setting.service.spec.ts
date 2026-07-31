import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import { storySettings, users } from "../database/schema";
import { reloadEnvForTesting } from "../env";
import { StorySettingService } from "./story-setting.service";

describe("StorySettingService", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication | undefined;
  let databaseService: DatabaseService;
  let storySettingService: StorySettingService;

  beforeEach(async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.LLM_BASE_URL = "";
    process.env.LLM_API_KEY = "";
    process.env.LLM_MODEL = "";
    process.env.LLM_TIMEOUT_MS = "";
    reloadEnvForTesting();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    databaseService = app.get(DatabaseService);
    storySettingService = app.get(StorySettingService);
    await databaseService.db.insert(users).values([
      {
        id: 1,
        uniqueName: "setting_user_a",
        displayName: "Setting User A",
        password: "hashed-password",
        createdAt: new Date(),
      },
      {
        id: 2,
        uniqueName: "setting_user_b",
        displayName: "Setting User B",
        password: "hashed-password",
        createdAt: new Date(),
      },
    ]);
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }

    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("creates settings with trimmed content and returns user-owned details", async () => {
    const created = await storySettingService.createSetting({
      userId: "1",
      body: {
        content: "  赛博城邦里，主角经营一家旧书店。  ",
      },
    });

    expect(created.setting).toMatchObject({
      id: "1",
      content: "赛博城邦里，主角经营一家旧书店。",
    });
    expect(created.setting.createdAt).toEqual(expect.any(String));

    await expect(
      storySettingService.getSettingForUser({
        userId: "1",
        settingId: created.setting.id,
      }),
    ).resolves.toEqual(created.setting);
  });

  it("lists only current user settings in descending creation order", async () => {
    await databaseService.db.insert(storySettings).values([
      {
        id: 1,
        userId: 1,
        content: "较早设定",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: 2,
        userId: 1,
        content: "较新设定",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: 3,
        userId: 2,
        content: "其他用户设定",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);

    const result = await storySettingService.listSettings("1");

    expect(result.settings).toEqual([
      {
        id: "2",
        preview: "较新设定",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "1",
        preview: "较早设定",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("does not expose settings owned by another user", async () => {
    await databaseService.db.insert(storySettings).values({
      id: 1,
      userId: 2,
      content: "其他用户设定",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      storySettingService.getSettingForUser({
        userId: "1",
        settingId: "1",
      }),
    ).resolves.toBeNull();
  });

  it("builds completion LLM requests from inspiration only", () => {
    const request = storySettingService.buildCompletionLlmRequest({
      inspiration: "蒸汽城市，女侦探和失忆机械师。",
    });

    expect(request.systemPrompt).toContain("补全成可复用的故事设定");
    expect(request.systemPrompt).not.toContain("蒸汽城市");
    expect(request.userPrompt).toContain("蒸汽城市，女侦探和失忆机械师。");
    expect(request.userPrompt).toContain("生成一份详细、可复用的故事设定");
  });
});
