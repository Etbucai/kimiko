import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import {
  storylineSegments,
  storylineSummaries,
  users,
} from "../database/schema";
import { reloadEnvForTesting } from "../env";
import { StorySegmentNotRewritableError } from "./storyline.errors";
import { StorylineService } from "./storyline.service";

describe("StorylineService", () => {
  const originalEnv = { ...process.env };
  const historyScoreConfig = {
    appendScore: 5,
    dialogueScore: 1,
    scoreLimit: 100,
  };
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

  it("saves dialogue segments, exposes chapter counts and leaves summaries unchanged for no-op dialogue", async () => {
    const created = await storylineService.saveCreatedStorylineWithSummary({
      userId: "1",
      initialStoryText: "大凡窝在沙发上。",
      instruction: "让馥冰登场。",
      generatedText: "馥冰站在厨房门口，皱眉看着他。",
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
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "站在厨房门口",
          },
        ],
      },
    });
    const previousSummary = {
      characters: [
        {
          name: "馥冰",
          aliases: [],
          identity: "住在同一屋檐下的少女",
          relationships: ["经常和大凡拌嘴"],
          motivation: "",
          currentStatus: "站在厨房门口",
        },
      ],
    };

    const withDialogue = await storylineService.saveDialogueSegmentWithSummary({
      userId: "1",
      storylineId: created.id,
      input: "大凡让馥冰拿奶茶。",
      generatedText: '大凡朝厨房喊了一声，馥冰白了他一眼，"你自己没长手啊。"',
      model: "dialogue-model",
      elapsedMs: 15,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      previousSummary,
      characterSummary: {
        characters: [
          {
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "正嫌弃地回应大凡",
          },
        ],
      },
    });

    expect(withDialogue.segments.at(-1)).toMatchObject({
      type: "generated",
      generationMode: "dialogue",
      text: '大凡朝厨房喊了一声，馥冰白了他一眼，"你自己没长手啊。"',
    });

    const list = await storylineService.listStorylines("1");
    expect(list.storylines[0]).toMatchObject({
      segmentCount: 3,
      chapterCount: 2,
      preview: '大凡朝厨房喊了一声，馥冰白了他一眼，"你自己没长手啊。"',
    });

    const summaryBeforeNoOp = await databaseService.db
      .select()
      .from(storylineSummaries)
      .where(eq(storylineSummaries.storylineId, Number(created.id)))
      .limit(1);
    const noOpDialogue =
      await storylineService.saveDialogueSegmentWithoutSummaryUpdate({
        userId: "1",
        storylineId: created.id,
        input: "大凡看向门外。",
        generatedText: "无事发生",
        model: "dialogue-model",
        elapsedMs: 5,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
        previousSummary,
      });
    const summaryAfterNoOp = await databaseService.db
      .select()
      .from(storylineSummaries)
      .where(eq(storylineSummaries.storylineId, Number(created.id)))
      .limit(1);

    expect(noOpDialogue.segments.at(-1)).toMatchObject({
      type: "generated",
      generationMode: "dialogue",
      text: "无事发生",
    });
    expect(summaryAfterNoOp).toEqual(summaryBeforeNoOp);
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
      historyScoreConfig,
    });

    expect(context.targetGenerationMode).toBe("append");
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
    if (context.targetGenerationMode !== "append") {
      throw new Error("Expected append rewrite context");
    }

    expect(context.writerContext.originalInstruction).toBe("进入钟楼。");
    expect(context.writerContext.originalGeneratedText).toBe(
      "林夏推开钟楼木门。",
    );
    expect(context.writerContext.historyRoundsBeforeTarget).toEqual([
      {
        roundIndex: 1,
        generationMode: "append",
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
        historyScoreConfig,
      }),
    ).rejects.toThrow(StorySegmentNotRewritableError);

    await expect(
      storylineService.buildRewriteLlmContext({
        userId: "1",
        storylineId: created.id,
        segmentId: generatedSegmentIds[0] ?? "",
        rewriteInstruction: "重写旧段。",
        historyScoreConfig,
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
      generationMode: "append",
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
        historyScoreConfig,
      }),
    ).rejects.toThrow(
      "Storyline generated segment is missing previous summary",
    );
  });

  it("builds dialogue context and rewrites latest dialogue segments with dialogue context", async () => {
    const created = await storylineService.saveCreatedStorylineWithSummary({
      userId: "1",
      initialStoryText: "大凡窝在沙发上。",
      instruction: "让馥冰登场。",
      generatedText: "馥冰站在厨房门口，皱眉看着他。",
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
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "站在厨房门口",
          },
        ],
      },
    });
    const dialogue = await storylineService.saveDialogueSegmentWithSummary({
      userId: "1",
      storylineId: created.id,
      input: "大凡让馥冰拿奶茶。",
      generatedText: '馥冰白了他一眼，"你自己没长手啊。"',
      model: "dialogue-model",
      elapsedMs: 15,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      previousSummary: {
        characters: [
          {
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "站在厨房门口",
          },
        ],
      },
      characterSummary: {
        characters: [
          {
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "正嫌弃地回应大凡",
          },
        ],
      },
    });

    const dialogueContext = await storylineService.buildDialogueLlmContext({
      userId: "1",
      storylineId: created.id,
      input: "大凡继续使唤馥冰。",
      historyScoreConfig: {
        appendScore: 5,
        dialogueScore: 1,
        scoreLimit: 5,
      },
    });

    expect(dialogueContext.writerContext.currentSceneText).toContain(
      "馥冰站在厨房门口",
    );
    expect(dialogueContext.writerContext.currentSceneText).toContain("互动：");
    expect(dialogueContext.writerContext.currentSceneText).toContain(
      "你自己没长手啊",
    );
    expect(dialogueContext.summaryHistoryRounds).toEqual([
      {
        roundIndex: 2,
        generationMode: "dialogue",
        instruction: "大凡让馥冰拿奶茶。",
        generatedText: '馥冰白了他一眼，"你自己没长手啊。"',
      },
    ]);

    const rewriteContext = await storylineService.buildRewriteLlmContext({
      userId: "1",
      storylineId: created.id,
      segmentId: dialogue.latestGeneration.segmentId,
      rewriteInstruction: "更不耐烦。",
      historyScoreConfig,
    });

    expect(rewriteContext.targetGenerationMode).toBe("dialogue");
    if (rewriteContext.targetGenerationMode !== "dialogue") {
      throw new Error("Expected dialogue rewrite context");
    }

    expect(rewriteContext.writerContext.originalInput).toBe(
      "大凡让馥冰拿奶茶。",
    );
    expect(rewriteContext.writerContext.originalGeneratedText).toContain(
      "你自己没长手啊",
    );
    expect(rewriteContext.writerContext.currentSceneText).toContain(
      "馥冰站在厨房门口",
    );

    const rewritten = await storylineService.saveRewrittenSegmentWithSummary({
      userId: "1",
      storylineId: created.id,
      segmentId: dialogue.latestGeneration.segmentId,
      instruction: "更不耐烦。",
      generatedText: '馥冰瞪了他一眼，"你烦不烦，自己拿。"',
      model: "rewrite-model",
      elapsedMs: 20,
      usage: {
        inputTokens: 6,
        outputTokens: 7,
        totalTokens: 13,
      },
      characterSummary: {
        characters: [
          {
            name: "馥冰",
            aliases: [],
            identity: "住在同一屋檐下的少女",
            relationships: ["经常和大凡拌嘴"],
            motivation: "",
            currentStatus: "正不耐烦地拒绝大凡",
          },
        ],
      },
    });

    expect(rewritten.segments.at(-1)).toMatchObject({
      id: dialogue.latestGeneration.segmentId,
      type: "generated",
      generationMode: "dialogue",
      text: '馥冰瞪了他一眼，"你烦不烦，自己拿。"',
    });
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
