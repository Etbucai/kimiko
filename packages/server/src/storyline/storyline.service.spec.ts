import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import { storylineSegments, users } from "../database/schema";
import { reloadEnvForTesting } from "../env";
import { StorySegmentNotRewritableError } from "./storyline.errors";
import { StorylineService } from "./storyline.service";

describe("StorylineService", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication | undefined;
  let databaseService: DatabaseService;
  let storylineService: StorylineService;

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
    storylineService = app.get(StorylineService);
    await databaseService.db.insert(users).values({
      id: 1,
      uniqueName: "storyline_service_user",
      displayName: "Storyline Service User",
      password: "hashed-password",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }

    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("stores previous summaries for created and appended generated segments", async () => {
    const created = await storylineService.saveCreatedStorylineWithSummary({
      userId: "1",
      initialStoryText: "雨停以后。",
      instruction: "前往钟楼。",
      generatedText: "林夏走向钟楼。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      characterSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "记者",
            relationships: [],
            motivation: "调查钟楼",
            currentStatus: "正在前往钟楼",
          },
        ],
      },
    });

    await storylineService.saveAppendedSegmentWithSummary({
      userId: "1",
      storylineId: created.id,
      instruction: "进入钟楼。",
      generatedText: "林夏推开钟楼木门。",
      model: "story-model",
      elapsedMs: 20,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      previousSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "记者",
            relationships: [],
            motivation: "调查钟楼",
            currentStatus: "正在前往钟楼",
          },
        ],
      },
      characterSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "记者",
            relationships: [],
            motivation: "调查钟楼",
            currentStatus: "正在钟楼门口",
          },
        ],
      },
    });

    const segments = await databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, Number(created.id)))
      .orderBy(storylineSegments.orderIndex);

    expect(segments).toHaveLength(3);
    expect(segments[0]?.previousSummaryJson).toBeNull();
    expect(parseJson(segments[1]?.previousSummaryJson)).toEqual({
      characters: [],
    });
    expect(parseJson(segments[2]?.previousSummaryJson)).toEqual({
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在前往钟楼",
        },
      ],
    });
  });

  it("builds rewrite context only for the latest generated segment", async () => {
    const created = await createTwoGeneratedSegmentStoryline(storylineService);
    const generatedSegmentIds = created.segments
      .filter((segment) => segment.type === "generated")
      .map((segment) => segment.id);

    const context = await storylineService.buildRewriteLlmContext({
      userId: "1",
      storylineId: created.id,
      segmentId: generatedSegmentIds[1] ?? "",
      rewriteInstruction: "文风更加轻快。",
      historyRoundLimit: 10,
    });

    expect(context.previousSummary).toEqual({
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在前往钟楼",
        },
      ],
    });
    expect(context.writerContext.originalInstruction).toBe("进入钟楼。");
    expect(context.writerContext.originalGeneratedText).toBe(
      "林夏推开钟楼木门。",
    );
    expect(context.writerContext.historyRoundsBeforeTarget).toEqual([
      {
        roundIndex: 1,
        instruction: "前往钟楼。",
        generatedText: "林夏走向钟楼。",
      },
    ]);

    await expect(
      storylineService.buildRewriteLlmContext({
        userId: "1",
        storylineId: created.id,
        segmentId: created.segments[0]?.id ?? "",
        rewriteInstruction: "重写初始正文。",
        historyRoundLimit: 10,
      }),
    ).rejects.toThrow(StorySegmentNotRewritableError);

    await expect(
      storylineService.buildRewriteLlmContext({
        userId: "1",
        storylineId: created.id,
        segmentId: generatedSegmentIds[0] ?? "",
        rewriteInstruction: "重写旧段。",
        historyRoundLimit: 10,
      }),
    ).rejects.toThrow(StorySegmentNotRewritableError);
  });

  it("rewrites the latest segment in place without changing previous summary", async () => {
    const created = await createTwoGeneratedSegmentStoryline(storylineService);
    const latestSegmentId = created.latestGeneration.segmentId;
    const beforeSegments = await databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, Number(created.id)))
      .orderBy(storylineSegments.orderIndex);
    const beforePreviousSummaryJson = beforeSegments.find(
      (segment) => String(segment.id) === latestSegmentId,
    )?.previousSummaryJson;

    const rewritten = await storylineService.saveRewrittenSegmentWithSummary({
      userId: "1",
      storylineId: created.id,
      segmentId: latestSegmentId,
      instruction: "文风更加轻快。",
      generatedText: "林夏轻快地推开钟楼木门。",
      model: "rewrite-model",
      elapsedMs: 30,
      usage: {
        inputTokens: 7,
        outputTokens: 8,
        totalTokens: 15,
      },
      characterSummary: {
        characters: [
          {
            name: "林夏",
            aliases: [],
            identity: "记者",
            relationships: [],
            motivation: "调查钟楼",
            currentStatus: "正在钟楼门口观察",
          },
        ],
      },
    });

    expect(rewritten.segments).toHaveLength(3);
    expect(rewritten.latestGeneration.segmentId).toBe(latestSegmentId);
    expect(rewritten.latestGeneration.model).toBe("rewrite-model");
    expect(rewritten.latestGeneration.usage.totalTokens).toBe(15);
    expect(rewritten.segments[2]).toMatchObject({
      id: latestSegmentId,
      type: "generated",
      text: "林夏轻快地推开钟楼木门。",
    });

    const afterSegments = await databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, Number(created.id)))
      .orderBy(storylineSegments.orderIndex);

    expect(afterSegments).toHaveLength(3);
    expect(
      afterSegments.find((segment) => String(segment.id) === latestSegmentId)
        ?.previousSummaryJson,
    ).toBe(beforePreviousSummaryJson);
  });

  it("rejects rewrite when previous summary JSON is missing", async () => {
    const created = await createTwoGeneratedSegmentStoryline(storylineService);
    const latestSegmentId = created.latestGeneration.segmentId;

    await databaseService.db
      .update(storylineSegments)
      .set({ previousSummaryJson: null })
      .where(eq(storylineSegments.id, Number(latestSegmentId)));

    await expect(
      storylineService.buildRewriteLlmContext({
        userId: "1",
        storylineId: created.id,
        segmentId: latestSegmentId,
        rewriteInstruction: "文风更加轻快。",
        historyRoundLimit: 10,
      }),
    ).rejects.toThrow(
      "Storyline generated segment is missing previous summary",
    );
  });
});

async function createTwoGeneratedSegmentStoryline(
  storylineService: StorylineService,
) {
  const created = await storylineService.saveCreatedStorylineWithSummary({
    userId: "1",
    initialStoryText: "雨停以后。",
    instruction: "前往钟楼。",
    generatedText: "林夏走向钟楼。",
    model: "story-model",
    elapsedMs: 10,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    },
    characterSummary: {
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在前往钟楼",
        },
      ],
    },
  });

  return storylineService.saveAppendedSegmentWithSummary({
    userId: "1",
    storylineId: created.id,
    instruction: "进入钟楼。",
    generatedText: "林夏推开钟楼木门。",
    model: "story-model",
    elapsedMs: 20,
    usage: {
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    },
    previousSummary: {
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在前往钟楼",
        },
      ],
    },
    characterSummary: {
      characters: [
        {
          name: "林夏",
          aliases: [],
          identity: "记者",
          relationships: [],
          motivation: "调查钟楼",
          currentStatus: "正在钟楼门口",
        },
      ],
    },
  });
}

function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(value) as unknown;
}
