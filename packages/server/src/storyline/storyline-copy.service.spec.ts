import type { INestApplication } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { eq } from "drizzle-orm";
import { AppModule } from "../app.module";
import { configureApp } from "../app.config";
import { DatabaseService } from "../database/database.service";
import {
  storylineContexts,
  storylineSegments,
  storylines,
  users,
} from "../database/schema";
import { reloadEnvForTesting } from "../env";
import { serializeStoryContext } from "./storyline-context-normalize";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";
import { StorylineCopyService } from "./storyline-copy.service";
import {
  StorylineBusyError,
  StorylineCopyChapterOutOfRangeError,
  StorylineCopyFailedError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

describe("StorylineCopyService", () => {
  const originalEnv = { ...process.env };
  let app: INestApplication | undefined;
  let copyService: StorylineCopyService;
  let databaseService: DatabaseService;
  let lockService: StorylineLockService;
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

    copyService = app.get(StorylineCopyService);
    databaseService = app.get(DatabaseService);
    lockService = app.get(StorylineLockService);
    storylineService = app.get(StorylineService);
    await databaseService.db.insert(users).values([
      {
        id: 1,
        uniqueName: "storyline_copy_user",
        displayName: "Storyline Copy User",
        password: "hashed-password",
        createdAt: new Date(),
      },
      {
        id: 2,
        uniqueName: "storyline_copy_other",
        displayName: "Storyline Copy Other",
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

  it("copies complete chapters, metadata, and remapped contexts", async () => {
    const source = await storylineService.saveCreatedStorylineWithContext({
      userId: "1",
      initialStoryText: "雨停以后。",
      instruction: "前往钟楼。",
      generatedText: "林夏走向钟楼。",
      model: "create-model",
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
    const chapterTwoContext = await getRequiredContext(
      storylineService,
      source.id,
    );
    await storylineService.saveAppendedSegmentWithContext({
      userId: "1",
      storylineId: source.id,
      instruction: "进入钟楼。",
      targetLength: 750,
      generatedText: "林夏推开钟楼木门。",
      model: "append-model",
      elapsedMs: 20,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
      previousContext: chapterTwoContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏进入钟楼。",
      }),
    });
    const chapterThreeContext = await getRequiredContext(
      storylineService,
      source.id,
    );
    await storylineService.saveDialogueSegmentWithContext({
      userId: "1",
      storylineId: source.id,
      input: "林夏呼喊程溪。",
      generatedText: "回声穿过空荡的钟楼。",
      model: "dialogue-model",
      elapsedMs: 30,
      usage: {
        inputTokens: 6,
        outputTokens: 7,
        totalTokens: 13,
      },
      previousContext: chapterThreeContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "林夏在钟楼呼喊程溪。",
      }),
    });

    const result = await copyService.copyStoryline({
      body: {
        title: "钟楼分支",
        throughChapter: 3,
      },
      sourceStorylineId: source.id,
      userId: "1",
    });

    expect(result.storyline).toMatchObject({
      title: "钟楼分支",
      chapterCount: 3,
      anchorPage: 3,
    });
    expect(result.storyline.chapters.at(-1)?.segments).toHaveLength(2);

    const [sourceSegments, copiedSegments] = await Promise.all([
      getSegments(databaseService, Number(source.id)),
      getSegments(databaseService, Number(result.storyline.id)),
    ]);
    expect(copiedSegments).toHaveLength(4);
    expect(copiedSegments.map((segment) => segment.id)).not.toEqual(
      sourceSegments.map((segment) => segment.id),
    );
    expect(
      copiedSegments.map((segment) => ({
        orderIndex: segment.orderIndex,
        chapterIndex: segment.chapterIndex,
        type: segment.type,
        generationMode: segment.generationMode,
        text: segment.text,
        instruction: segment.instruction,
        model: segment.model,
        elapsedMs: segment.elapsedMs,
        inputTokens: segment.inputTokens,
        outputTokens: segment.outputTokens,
        totalTokens: segment.totalTokens,
        targetLength: segment.targetLength,
        previousContextOrderIndex: segment.previousContextOrderIndex,
      })),
    ).toEqual(
      sourceSegments.map((segment) => ({
        orderIndex: segment.orderIndex,
        chapterIndex: segment.chapterIndex,
        type: segment.type,
        generationMode: segment.generationMode,
        text: segment.text,
        instruction: segment.instruction,
        model: segment.model,
        elapsedMs: segment.elapsedMs,
        inputTokens: segment.inputTokens,
        outputTokens: segment.outputTokens,
        totalTokens: segment.totalTokens,
        targetLength: segment.targetLength,
        previousContextOrderIndex: segment.previousContextOrderIndex,
      })),
    );

    const copiedIds = new Set(
      copiedSegments.map((segment) => String(segment.id)),
    );
    const sourceIds = new Set(
      sourceSegments.map((segment) => String(segment.id)),
    );
    const copiedContext = await getRequiredContext(
      storylineService,
      result.storyline.id,
    );
    expectAllSourcesBelongTo(copiedContext, copiedIds);
    expect(
      collectSourceSegmentIds(copiedContext).some((id) => sourceIds.has(id)),
    ).toBe(false);

    for (const segment of copiedSegments) {
      if (segment.previousContextJson === null) {
        continue;
      }

      const previousContext = JSON.parse(
        segment.previousContextJson,
      ) as typeof copiedContext;
      expectAllSourcesBelongTo(previousContext, copiedIds);
    }

    const list = await storylineService.listStorylines("1");
    expect(list.storylines[0]).toMatchObject({
      id: result.storyline.id,
      title: "钟楼分支",
      chapterCount: 3,
    });
    expect(list.storylines[1]?.title).toBe("雨停以后。");
  });

  it("uses the first excluded segment snapshot when current context is ahead", async () => {
    const source = await storylineService.saveCreatedStorylineWithContext({
      userId: "1",
      initialStoryText: "第一章。",
      instruction: "写第二章。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "第二章事实。",
      }),
    });
    const chapterTwoContext = await getRequiredContext(
      storylineService,
      source.id,
    );
    await storylineService.saveAppendedSegmentWithContext({
      userId: "1",
      storylineId: source.id,
      instruction: "写第三章。",
      targetLength: 250,
      generatedText: "第三章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      previousContext: chapterTwoContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "第三章事实。",
      }),
    });
    const chapterThreeContext = await getRequiredContext(
      storylineService,
      source.id,
    );
    await storylineService.saveAppendedSegmentWithContext({
      userId: "1",
      storylineId: source.id,
      instruction: "写第四章。",
      targetLength: 250,
      generatedText: "第四章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      previousContext: chapterThreeContext,
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "第四章事实。",
      }),
    });

    const result = await copyService.copyStoryline({
      body: {
        title: "只到第二章",
        throughChapter: 2,
      },
      sourceStorylineId: source.id,
      userId: "1",
    });
    const state = await storylineService.getStoryContextExtractionState(
      "1",
      result.storyline.id,
    );

    expect(result.storyline.chapterCount).toBe(2);
    expect(state.extractedThroughOrderIndex).toBe(1);
    expect(state.pendingRoundCount).toBe(0);
    expect(state.context?.worldFacts.map((fact) => fact.text)).toEqual([
      "第二章事实。",
    ]);
    expect(
      collectSourceSegmentIds(state.context ?? emptyContext()).every((id) =>
        result.storyline.chapters.some((chapter) =>
          chapter.segments.some((segment) => segment.id === id),
        ),
      ),
    ).toBe(true);
  });

  it("keeps pending rounds when the nearest safe snapshot is older than the cutoff", async () => {
    const source = await storylineService.saveCreatedStoryline({
      userId: "1",
      initialStoryText: "第一章。",
      instruction: "写第二章。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
    await storylineService.saveAppendedSegment({
      userId: "1",
      storylineId: source.id,
      instruction: "写第三章。",
      targetLength: 250,
      generatedText: "第三章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });
    const sourceSegments = await getSegments(
      databaseService,
      Number(source.id),
    );
    const latestSourceSegment = sourceSegments.at(-1);
    if (latestSourceSegment === undefined) {
      throw new Error("Expected source segment");
    }
    const now = new Date();
    await databaseService.db.insert(storylineContexts).values({
      storylineId: Number(source.id),
      contextJson: serializeStoryContext({
        worldFacts: [
          {
            id: "fact_1",
            kind: "event",
            text: "第三章事实。",
            status: "active",
            visibility: "observable",
            sourceSegmentIds: [String(latestSourceSegment.id)],
          },
        ],
        characters: [],
        currentScene: {
          location: "",
          timeLabel: "",
          presentCharacterIds: [],
          observableFactIds: ["fact_1"],
          sceneStatus: "",
          sourceSegmentIds: [String(latestSourceSegment.id)],
        },
      }),
      extractedThroughOrderIndex: latestSourceSegment.orderIndex,
      createdAt: now,
      updatedAt: now,
    });

    const result = await copyService.copyStoryline({
      body: {
        title: "安全快照",
        throughChapter: 2,
      },
      sourceStorylineId: source.id,
      userId: "1",
    });
    const state = await storylineService.getStoryContextExtractionState(
      "1",
      result.storyline.id,
    );

    expect(state).toMatchObject({
      context: null,
      extractedThroughOrderIndex: 0,
      pendingRoundCount: 1,
    });
  });

  it("rejects invalid requests, inaccessible stories, and busy stories", async () => {
    const source = await storylineService.saveCreatedStoryline({
      userId: "1",
      initialStoryText: "第一章。",
      instruction: "写第二章。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    });

    await expect(
      copyService.copyStoryline({
        body: { title: "", throughChapter: 1 },
        sourceStorylineId: source.id,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      copyService.copyStoryline({
        body: { title: "越界", throughChapter: 99 },
        sourceStorylineId: source.id,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(StorylineCopyChapterOutOfRangeError);
    await expect(
      copyService.copyStoryline({
        body: { title: "越权", throughChapter: 1 },
        sourceStorylineId: source.id,
        userId: "2",
      }),
    ).rejects.toBeInstanceOf(StorylineNotFoundError);

    const releaseLock = lockService.acquireStorylineLock(source.id);
    try {
      await expect(
        copyService.copyStoryline({
          body: { title: "忙碌", throughChapter: 1 },
          sourceStorylineId: source.id,
          userId: "1",
        }),
      ).rejects.toBeInstanceOf(StorylineBusyError);
    } finally {
      releaseLock();
    }
  });

  it("rolls back when context references a segment outside the prefix", async () => {
    const source = await storylineService.saveCreatedStorylineWithContext({
      userId: "1",
      initialStoryText: "第一章。",
      instruction: "写第二章。",
      generatedText: "第二章。",
      model: "story-model",
      elapsedMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      contextPatch: createContextPatch({
        characterName: "林夏",
        factText: "第二章事实。",
      }),
    });
    const context = await getRequiredContext(storylineService, source.id);
    const corruptedContext = {
      ...context,
      worldFacts: context.worldFacts.map((fact, index) =>
        index === 0 ? { ...fact, sourceSegmentIds: ["999999"] } : fact,
      ),
    };
    await databaseService.db
      .update(storylineContexts)
      .set({ contextJson: serializeStoryContext(corruptedContext) })
      .where(eq(storylineContexts.storylineId, Number(source.id)));
    const storylinesBefore = await databaseService.db.select().from(storylines);

    await expect(
      copyService.copyStoryline({
        body: { title: "损坏副本", throughChapter: 2 },
        sourceStorylineId: source.id,
        userId: "1",
      }),
    ).rejects.toBeInstanceOf(StorylineCopyFailedError);

    const storylinesAfter = await databaseService.db.select().from(storylines);
    expect(storylinesAfter).toHaveLength(storylinesBefore.length);
  });
});

async function getSegments(
  databaseService: DatabaseService,
  storylineId: number,
) {
  return databaseService.db
    .select()
    .from(storylineSegments)
    .where(eq(storylineSegments.storylineId, storylineId))
    .orderBy(storylineSegments.orderIndex);
}

async function getRequiredContext(
  storylineService: StorylineService,
  storylineId: string,
) {
  const context = await storylineService.getStoryContextForUser(
    "1",
    storylineId,
  );
  if (context === null) {
    throw new Error("Expected story context");
  }

  return context;
}

function collectSourceSegmentIds(
  context: Awaited<ReturnType<typeof getRequiredContext>>,
): string[] {
  return [
    ...context.worldFacts.flatMap((fact) => fact.sourceSegmentIds),
    ...context.characters.flatMap((character) => [
      ...character.sourceSegmentIds,
      ...character.relationships.flatMap(
        (relationship) => relationship.sourceSegmentIds,
      ),
      ...character.beliefs.flatMap((belief) => belief.sourceSegmentIds),
      ...character.opinions.flatMap((opinion) => opinion.sourceSegmentIds),
    ]),
    ...context.currentScene.sourceSegmentIds,
  ];
}

function expectAllSourcesBelongTo(
  context: Awaited<ReturnType<typeof getRequiredContext>>,
  expectedIds: ReadonlySet<string>,
): void {
  for (const sourceId of collectSourceSegmentIds(context)) {
    expect(expectedIds.has(sourceId)).toBe(true);
  }
}

function emptyContext(): Awaited<ReturnType<typeof getRequiredContext>> {
  return {
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
  };
}

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
