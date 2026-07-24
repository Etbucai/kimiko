import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import { storylineSegments, users } from "../database/schema";
import { reloadEnvForTesting } from "../env";
import { StorylineService } from "./storyline.service";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";

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

  it("stores previous contexts for created and appended generated segments", async () => {
    const created = await storylineService.saveCreatedStorylineWithContext({
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
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏正在前往钟楼。",
      }),
    });
    const createdContext = await storylineService.getStoryContextForUser(
      "1",
      created.id,
    );
    if (createdContext === null) {
      throw new Error("Expected created context");
    }

    await storylineService.saveAppendedSegmentWithContext({
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
      previousContext: createdContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏推开钟楼木门。",
      }),
    });

    const segments = await databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, Number(created.id)))
      .orderBy(storylineSegments.orderIndex);

    expect(segments).toHaveLength(3);
    expect(segments[0]?.previousContextJson).toBeNull();
    expect(parseJson(segments[1]?.previousContextJson)).toEqual({
      worldFacts: [],
      characters: [],
      currentScene: {
        location: "",
        timeLabel: "",
        presentCharacterIds: [],
        observableFactIds: [],
        sceneStatus: "",
        sourceSegmentIds: [],
      },
    });
    expect(parseJson(segments[2]?.previousContextJson)).toEqual(createdContext);

    const finalContext = await storylineService.getStoryContextForUser(
      "1",
      created.id,
    );
    expect(finalContext?.characters[0]?.id).toBe("char_1");
    expect(finalContext?.worldFacts.map((fact) => fact.id)).toEqual([
      "fact_1",
      "fact_2",
    ]);
  });

  it("saves no-op dialogue without updating context and keeps chapter count stable", async () => {
    const created = await storylineService.saveCreatedStorylineWithContext({
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
      contextPatch: createContextPatch({
        characterName: "馥冰",
        factText: "馥冰站在厨房门口。",
      }),
    });
    const previousContext = await storylineService.getStoryContextForUser(
      "1",
      created.id,
    );
    if (previousContext === null) {
      throw new Error("Expected context");
    }

    const afterNoOp =
      await storylineService.saveDialogueSegmentWithoutContextUpdate({
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
        previousContext,
      });

    const contextAfterNoOp = await storylineService.getStoryContextForUser(
      "1",
      created.id,
    );
    expect(contextAfterNoOp).toEqual(previousContext);
    expect(afterNoOp.segments.at(-1)).toMatchObject({
      type: "generated",
      generationMode: "dialogue",
      text: "无事发生",
    });

    const list = await storylineService.listStorylines("1");
    expect(list.storylines[0]?.segmentCount).toBe(3);
    expect(list.storylines[0]?.chapterCount).toBe(2);
  });

  it("builds rewrite context from previous context and rewrites latest segment in place", async () => {
    const created = await storylineService.saveCreatedStorylineWithContext({
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
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏正在前往钟楼。",
      }),
    });
    const createdContext = await storylineService.getStoryContextForUser(
      "1",
      created.id,
    );
    if (createdContext === null) {
      throw new Error("Expected created context");
    }
    const appended = await storylineService.saveAppendedSegmentWithContext({
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
      previousContext: createdContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏推开钟楼木门。",
      }),
    });

    const context = await storylineService.buildRewriteLlmContext({
      userId: "1",
      storylineId: created.id,
      segmentId: appended.latestGeneration.segmentId,
      rewriteInstruction: "文风更轻快。",
      historyScoreConfig,
    });

    expect(context.previousContext).toEqual(createdContext);
    expect(context.contextHistoryRounds).toEqual([
      {
        segmentId: "2",
        roundIndex: 1,
        generationMode: "append",
        instruction: "前往钟楼。",
        generatedText: "林夏走向钟楼。",
      },
    ]);

    const rewritten = await storylineService.saveRewrittenSegmentWithContext({
      userId: "1",
      storylineId: created.id,
      segmentId: appended.latestGeneration.segmentId,
      instruction: "文风更轻快。",
      generatedText: "林夏轻快地推开钟楼木门。",
      model: "rewrite-model",
      elapsedMs: 30,
      usage: {
        inputTokens: 6,
        outputTokens: 7,
        totalTokens: 13,
      },
      previousContext: context.previousContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏轻快地推开钟楼木门。",
      }),
    });

    expect(rewritten.latestGeneration.segmentId).toBe(
      appended.latestGeneration.segmentId,
    );
    expect(rewritten.segments.at(-1)?.text).toBe("林夏轻快地推开钟楼木门。");
  });
});

function createContextPatch(input: {
  readonly characterName: string;
  readonly factText: string;
}): StoryContextPatchDraft {
  return {
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [
        {
          draftKey: "main_fact",
          kind: "event",
          text: input.factText,
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
          draftKey: "main_character",
          name: input.characterName,
          identity: "主要角色",
          currentStatus: input.factText,
          beliefsAdded: [
            {
              text: input.factText,
              truthStatus: "true",
              factRefs: ["main_fact"],
            },
          ],
        },
      ],
      update: [],
    },
    currentScene: {
      location: "当前场景",
      timeLabel: "当前",
      presentCharacterRefs: ["main_character"],
      observableFactRefs: ["main_fact"],
      sceneStatus: input.factText,
    },
  };
}

function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.parse(value) as unknown;
}
