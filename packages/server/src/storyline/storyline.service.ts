import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { STORYLINE_CHAPTER_CACHE_RADIUS } from "@kimiko/schema";
import type {
  CompletedStorylineSnapshot,
  GetRecentStorylineResponse,
  ListStorylinesResponse,
  StoryCharacterContext,
  StoryContextSnapshot,
  StoryTargetLength,
  StorylineGenerationMetadata,
  StorylineGenerationMode,
  StorylineChapter,
  StorylineListItem,
  StorylineSegment as StorylineSegmentDto,
  StorylineSnapshot,
  StoryWorldFact,
} from "@kimiko/schema";
import { and, count, desc, eq, gte, lte, max } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import {
  storylineContexts,
  storylineSegments,
  storylines,
} from "../database/schema";
import type {
  StoryDialogueLlmContext,
  StoryDialogueRewriteLlmContext,
  StoryHistoryRound,
  StoryLlmContext,
  StoryRewriteLlmContext,
  StoryWriterContextBundle,
} from "../story/story.service";
import {
  StoryContextFailedError,
  StorySegmentNotRewritableError,
  StorylineNotFoundError,
  StorylineSaveFailedError,
} from "./storyline.errors";
import {
  parseStoryContextJson,
  serializeStoryContext,
} from "./storyline-context-normalize";
import { applyStoryContextPatch } from "./storyline-context-patch";
import {
  emptyStoryContextSnapshot,
  normalizeContextMatchText,
  STORY_CONTEXT_LIMITS,
} from "./storyline-context.types";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";
import type {
  StoryContextExtractionBatch,
  StoryContextExtractionRound,
  StoryContextExtractionState,
} from "./storyline-context-extraction.types";
import type {
  SaveAppendedSegmentInput,
  SaveAppendedSegmentWithContextInput,
  SaveCreatedStorylineInput,
  SaveCreatedStorylineWithContextInput,
  SaveDialogueSegmentInput,
  SaveDialogueSegmentWithContextInput,
  SaveRewrittenSegmentInput,
  SaveRewrittenSegmentWithContextInput,
  HistoryScoreConfig,
  StorylineDialogueContext,
  StorylineRewriteContext,
  StorylineRecord,
} from "./storyline.types";
import { resolveStorylineTitle } from "./storyline-title";

type StorylineSegmentRow = typeof storylineSegments.$inferSelect;
type StorylineContextRow = typeof storylineContexts.$inferSelect;

const storylineListLimit = 50;
const storylineListPreviewMaxLength = 240;
const noOpDialogueText = "无事发生";

export interface StorylineWindowOptions {
  readonly anchorPage: number | "latest";
  readonly before: number;
  readonly after: number;
}

const defaultStorylineWindowOptions: StorylineWindowOptions = {
  anchorPage: "latest",
  before: STORYLINE_CHAPTER_CACHE_RADIUS,
  after: STORYLINE_CHAPTER_CACHE_RADIUS,
};

@Injectable()
export class StorylineService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listStorylines(userId: string): Promise<ListStorylinesResponse> {
    const internalUserId = parseAuthenticatedUserId(userId);
    const storylineRows = await this.databaseService.db
      .select()
      .from(storylines)
      .where(eq(storylines.userId, internalUserId))
      .orderBy(desc(storylines.updatedAt), desc(storylines.id))
      .limit(storylineListLimit);
    const items = await Promise.all(
      storylineRows.map(async (storyline) => {
        const [[initialSegment], [latestSegment], [counts]] = await Promise.all(
          [
            this.databaseService.db
              .select({ text: storylineSegments.text })
              .from(storylineSegments)
              .where(
                and(
                  eq(storylineSegments.storylineId, storyline.id),
                  eq(storylineSegments.type, "initial"),
                ),
              )
              .orderBy(storylineSegments.orderIndex)
              .limit(1),
            this.databaseService.db
              .select({ text: storylineSegments.text })
              .from(storylineSegments)
              .where(eq(storylineSegments.storylineId, storyline.id))
              .orderBy(desc(storylineSegments.orderIndex))
              .limit(1),
            this.databaseService.db
              .select({
                segmentCount: count(),
                chapterCount: max(storylineSegments.chapterIndex),
              })
              .from(storylineSegments)
              .where(eq(storylineSegments.storylineId, storyline.id)),
          ],
        );

        return mapListItemDto({
          id: storyline.id,
          explicitTitle: storyline.title,
          updatedAt: storyline.updatedAt,
          initialText: initialSegment?.text ?? "",
          latestText: latestSegment?.text ?? "",
          segmentCount: counts?.segmentCount ?? 0,
          chapterCount: counts?.chapterCount ?? 0,
        });
      }),
    );

    return { storylines: items };
  }

  async getRecentStoryline(
    userId: string,
    options: StorylineWindowOptions = defaultStorylineWindowOptions,
  ): Promise<GetRecentStorylineResponse> {
    const internalUserId = parseAuthenticatedUserId(userId);
    const [storyline] = await this.databaseService.db
      .select()
      .from(storylines)
      .where(eq(storylines.userId, internalUserId))
      .orderBy(desc(storylines.updatedAt), desc(storylines.id))
      .limit(1);

    if (storyline === undefined) {
      return { storyline: null };
    }

    const snapshot = await this.getSnapshotByInternalId(storyline.id, options);
    if (snapshot === null) {
      throw new InternalServerErrorException("Storyline snapshot is missing");
    }

    return { storyline: snapshot };
  }

  async getStorylineSnapshotForUser(
    userId: string,
    storylineId: string,
    options: StorylineWindowOptions = defaultStorylineWindowOptions,
  ): Promise<StorylineSnapshot | null> {
    const storyline = await this.getStorylineForUser(userId, storylineId);
    if (storyline === null) {
      return null;
    }

    const snapshot = await this.getSnapshotByInternalId(storyline.id, options);
    if (snapshot === null) {
      throw new InternalServerErrorException("Storyline snapshot is missing");
    }

    return snapshot;
  }

  async getStorylineForUser(
    userId: string,
    storylineId: string,
  ): Promise<StorylineRecord | null> {
    const internalUserId = parseAuthenticatedUserId(userId);
    const internalStorylineId = parseExternalId(storylineId);
    if (internalStorylineId === null) {
      return null;
    }

    const [storyline] = await this.databaseService.db
      .select()
      .from(storylines)
      .where(
        and(
          eq(storylines.id, internalStorylineId),
          eq(storylines.userId, internalUserId),
        ),
      )
      .limit(1);

    if (storyline === undefined) {
      return null;
    }

    return {
      id: storyline.id,
      externalId: String(storyline.id),
      userId: storyline.userId,
    };
  }

  async buildLlmContext(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly currentInstruction: string;
    readonly targetLength: StoryTargetLength;
    readonly historyScoreConfig: HistoryScoreConfig;
  }): Promise<StoryLlmContext> {
    const storyline = await this.getRequiredStorylineForUser(
      input.userId,
      input.storylineId,
    );
    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    const initialSegment = getRequiredInitialSegment(segments);
    const generatedRounds = mapGeneratedRounds(segments);
    const selectedHistory = selectRecentHistoryRounds(
      generatedRounds,
      input.historyScoreConfig,
    );
    const storedContext = await this.getStoryContextByInternalStorylineId(
      storyline.id,
    );
    const storyContext = storedContext ?? emptyStoryContextSnapshot;

    return {
      currentInstruction: input.currentInstruction,
      targetLength: input.targetLength,
      ...(selectedHistory.wasTrimmed
        ? {}
        : { initialStoryText: initialSegment.text }),
      contextBundle: buildWriterContextBundle({
        storyContext,
        contextWasMissing: storedContext === null,
        recentHistoryRounds: selectedHistory.rounds,
        historyWasTrimmed: selectedHistory.wasTrimmed,
        searchText: input.currentInstruction,
      }),
    };
  }

  async buildRewriteLlmContext(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly segmentId: string;
    readonly rewriteInstruction: string;
    readonly historyScoreConfig: HistoryScoreConfig;
  }): Promise<StorylineRewriteContext> {
    const storyline = await this.getRequiredStorylineForUser(
      input.userId,
      input.storylineId,
    );
    const targetSegmentId = parseExternalId(input.segmentId);
    if (targetSegmentId === null) {
      throw new StorySegmentNotRewritableError();
    }

    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    const initialSegment = getRequiredInitialSegment(segments);
    const targetSegment = validateRewritableSegment(segments, targetSegmentId);
    const previousContext = parseSegmentPreviousContext(targetSegment);
    const generatedSegmentsBeforeTarget = segments.filter(
      (segment) =>
        segment.type === "generated" &&
        segment.orderIndex < targetSegment.orderIndex,
    );
    const generatedRoundsBeforeTarget = mapGeneratedRounds(
      generatedSegmentsBeforeTarget,
    );
    const selectedHistory = selectRecentHistoryRounds(
      generatedRoundsBeforeTarget,
      input.historyScoreConfig,
    );
    const targetGenerationMode = getRequiredGenerationMode(
      targetSegment.generationMode,
    );
    const contextBundle = buildWriterContextBundle({
      storyContext: previousContext,
      contextWasMissing: targetSegment.previousContextJson === null,
      recentHistoryRounds: selectedHistory.rounds,
      historyWasTrimmed: selectedHistory.wasTrimmed,
      searchText: [
        input.rewriteInstruction,
        targetSegment.text,
        getNullableString(targetSegment.instruction),
      ].join("\n"),
    });
    const sharedContext = {
      storyline,
      targetSegmentId: String(targetSegment.id),
      targetGenerationMode,
      previousContext,
      contextHistoryRounds: selectedHistory.rounds,
      ...(selectedHistory.wasTrimmed
        ? {}
        : { initialStoryText: initialSegment.text }),
    };

    if (targetGenerationMode === "dialogue") {
      const writerContext: StoryDialogueRewriteLlmContext = {
        rewriteInstruction: input.rewriteInstruction,
        originalInput: getRequiredString(targetSegment.instruction, "input"),
        originalGeneratedText: targetSegment.text,
        currentSceneText: buildCurrentSceneText(
          segments.filter(
            (segment) => segment.orderIndex < targetSegment.orderIndex,
          ),
        ),
        contextBundle,
      };

      return {
        ...sharedContext,
        targetGenerationMode,
        writerContext,
      };
    }

    const rewriteTargetLength = getOptionalTargetLength(
      targetSegment.targetLength,
    );
    const writerContext: StoryRewriteLlmContext = {
      rewriteInstruction: input.rewriteInstruction,
      originalInstruction: getRequiredString(
        targetSegment.instruction,
        "instruction",
      ),
      originalGeneratedText: targetSegment.text,
      ...(rewriteTargetLength === undefined
        ? {}
        : { targetLength: rewriteTargetLength }),
      ...(selectedHistory.wasTrimmed
        ? {}
        : { initialStoryText: initialSegment.text }),
      contextBundle,
    };

    return {
      ...sharedContext,
      targetGenerationMode,
      writerContext,
    };
  }

  async buildDialogueLlmContext(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly input: string;
    readonly historyScoreConfig: HistoryScoreConfig;
  }): Promise<StorylineDialogueContext> {
    const storyline = await this.getRequiredStorylineForUser(
      input.userId,
      input.storylineId,
    );
    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    const initialSegment = getRequiredInitialSegment(segments);
    const generatedRounds = mapGeneratedRounds(segments);
    const selectedHistory = selectRecentHistoryRounds(
      generatedRounds,
      input.historyScoreConfig,
    );
    const storedContext = await this.getStoryContextByInternalStorylineId(
      storyline.id,
    );
    const previousContext = storedContext ?? emptyStoryContextSnapshot;
    const writerContext: StoryDialogueLlmContext = {
      input: input.input,
      currentSceneText: buildCurrentSceneText(segments),
      contextBundle: buildWriterContextBundle({
        storyContext: previousContext,
        contextWasMissing: storedContext === null,
        recentHistoryRounds: selectedHistory.rounds,
        historyWasTrimmed: selectedHistory.wasTrimmed,
        searchText: input.input,
      }),
    };

    return {
      storyline,
      previousContext,
      writerContext,
      contextHistoryRounds: selectedHistory.rounds,
      ...(selectedHistory.wasTrimmed
        ? {}
        : { initialStoryText: initialSegment.text }),
    };
  }

  async getStoryContextForUser(
    userId: string,
    storylineId: string,
  ): Promise<StoryContextSnapshot | null> {
    const storyline = await this.getRequiredStorylineForUser(
      userId,
      storylineId,
    );

    return this.getStoryContextByInternalStorylineId(storyline.id);
  }

  async getStoryContextExtractionState(
    userId: string,
    storylineId: string,
  ): Promise<StoryContextExtractionState> {
    const storyline = await this.getRequiredStorylineForUser(
      userId,
      storylineId,
    );
    const [segments, contextRow] = await Promise.all([
      this.getSegmentsByInternalStorylineId(storyline.id),
      this.getStoryContextRowByInternalStorylineId(storyline.id),
    ]);
    const extractedThroughOrderIndex =
      contextRow?.extractedThroughOrderIndex ?? 0;

    return {
      context:
        contextRow === undefined ? null : parseStoryContextRow(contextRow),
      extractedThroughOrderIndex,
      pendingRoundCount: getPendingContextSegments(
        segments,
        extractedThroughOrderIndex,
      ).length,
    };
  }

  async getStoryContextExtractionBatch(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly maxRoundCount: number;
  }): Promise<StoryContextExtractionBatch | null> {
    const storyline = await this.getRequiredStorylineForUser(
      input.userId,
      input.storylineId,
    );
    const [segments, contextRow] = await Promise.all([
      this.getSegmentsByInternalStorylineId(storyline.id),
      this.getStoryContextRowByInternalStorylineId(storyline.id),
    ]);
    const initialSegment = getRequiredInitialSegment(segments);
    const extractedThroughOrderIndex =
      contextRow?.extractedThroughOrderIndex ?? 0;
    const effectiveSegments = getEffectiveContextSegments(segments);
    const pendingSegments = effectiveSegments
      .filter((segment) => segment.orderIndex > extractedThroughOrderIndex)
      .slice(0, input.maxRoundCount);
    if (pendingSegments.length === 0) {
      return null;
    }

    const roundIndexBySegmentId = new Map(
      effectiveSegments.map((segment, index) => [segment.id, index + 1]),
    );
    const rounds = pendingSegments.map(
      (segment): StoryContextExtractionRound => ({
        segmentId: String(segment.id),
        orderIndex: segment.orderIndex,
        roundIndex: roundIndexBySegmentId.get(segment.id) ?? 1,
        generationMode: getRequiredGenerationMode(segment.generationMode),
        instruction: getRequiredString(segment.instruction, "instruction"),
        generatedText: segment.text,
      }),
    );
    const firstRound = rounds[0];
    if (firstRound === undefined) {
      return null;
    }

    return {
      expectedExtractedThroughOrderIndex: extractedThroughOrderIndex,
      initialSegmentId: String(initialSegment.id),
      initialStoryText: initialSegment.text,
      previousContext:
        contextRow === undefined ? null : parseStoryContextRow(contextRow),
      rounds: [firstRound, ...rounds.slice(1)],
    };
  }

  async applyStoryContextExtractionBatch(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly batch: StoryContextExtractionBatch;
    readonly contextPatch: StoryContextPatchDraft;
  }): Promise<void> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);

    try {
      this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const contextRow = getContextForTransaction(
          transaction,
          internalStorylineId,
        );
        const currentExtractedThroughOrderIndex =
          contextRow?.extractedThroughOrderIndex ?? 0;
        if (
          currentExtractedThroughOrderIndex !==
          input.batch.expectedExtractedThroughOrderIndex
        ) {
          throw new StoryContextFailedError(
            "Story context extraction cursor changed",
          );
        }

        const lastRound = input.batch.rounds.at(-1);
        if (lastRound === undefined) {
          throw new StoryContextFailedError(
            "Story context extraction batch is empty",
          );
        }

        const sourceRefToSegmentId = new Map<string, string>([
          ["initial", input.batch.initialSegmentId],
          ["current", lastRound.segmentId],
        ]);
        for (const round of input.batch.rounds.slice(0, -1)) {
          sourceRefToSegmentId.set(
            `segment:${round.segmentId}`,
            round.segmentId,
          );
        }

        upsertContext(transaction, {
          storylineId: internalStorylineId,
          context: applyStoryContextPatch({
            previousContext: input.batch.previousContext,
            patch: input.contextPatch,
            sourceRefToSegmentId,
          }),
          extractedThroughOrderIndex: lastRound.orderIndex,
          now: new Date(),
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StoryContextFailedError
      ) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }
  }

  async saveCreatedStoryline(
    input: SaveCreatedStorylineInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        const now = new Date();
        const createdStoryline = transaction
          .insert(storylines)
          .values({
            userId: internalUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storylines.id })
          .get();
        if (createdStoryline === undefined) {
          throw new Error("Failed to insert storyline");
        }

        transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 0,
            chapterIndex: 1,
            type: "initial",
            generationMode: "append",
            text: input.initialStoryText.trim(),
            createdAt: now,
          })
          .run();
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 1,
            chapterIndex: 2,
            type: "generated",
            generationMode: "append",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousContextJson: serializeStoryContext(
              emptyStoryContextSnapshot,
            ),
            previousContextOrderIndex: 0,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();
        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        return {
          storylineId: createdStoryline.id,
          generatedSegmentId: generatedSegment.id,
        };
      });
    } catch (error: unknown) {
      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveCreatedStorylineWithContext(
    input: SaveCreatedStorylineWithContextInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        const now = new Date();
        const createdStoryline = transaction
          .insert(storylines)
          .values({
            userId: internalUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storylines.id })
          .get();

        if (createdStoryline === undefined) {
          throw new Error("Failed to insert storyline");
        }

        const initialSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 0,
            chapterIndex: 1,
            type: "initial",
            generationMode: "append",
            text: input.initialStoryText.trim(),
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (initialSegment === undefined) {
          throw new Error("Failed to insert initial segment");
        }

        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 1,
            chapterIndex: 2,
            type: "generated",
            generationMode: "append",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousContextJson: serializeStoryContext(
              emptyStoryContextSnapshot,
            ),
            previousContextOrderIndex: 0,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        const context = applyStoryContextPatch({
          previousContext: null,
          patch: input.contextPatch,
          sourceRefToSegmentId: new Map([
            ["initial", String(initialSegment.id)],
            ["current", String(generatedSegment.id)],
          ]),
        });
        const contextJson = serializeStoryContext(context);

        transaction
          .insert(storylineContexts)
          .values({
            storylineId: createdStoryline.id,
            contextJson,
            extractedThroughOrderIndex: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        return {
          storylineId: createdStoryline.id,
          generatedSegmentId: generatedSegment.id,
        };
      });
    } catch (error: unknown) {
      if (error instanceof StoryContextFailedError) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveAppendedSegment(
    input: SaveAppendedSegmentInput,
  ): Promise<CompletedStorylineSnapshot> {
    return this.saveGeneratedSegmentWithoutContextUpdate({
      userId: input.userId,
      storylineId: input.storylineId,
      generationMode: "append",
      instruction: input.instruction,
      targetLength: input.targetLength,
      generatedText: input.generatedText,
      model: input.model,
      elapsedMs: input.elapsedMs,
      usage: input.usage,
    });
  }

  async saveAppendedSegmentWithContext(
    input: SaveAppendedSegmentWithContextInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const segments = getSegmentsForTransaction(
          transaction,
          internalStorylineId,
        );
        const latestSegment = segments[segments.length - 1];
        if (latestSegment === undefined) {
          throw new Error("Storyline has no segments");
        }

        const contextRow = getContextForTransaction(
          transaction,
          internalStorylineId,
        );
        const now = new Date();
        const generatedOrderIndex = latestSegment.orderIndex + 1;
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: internalStorylineId,
            orderIndex: generatedOrderIndex,
            chapterIndex: latestSegment.chapterIndex + 1,
            type: "generated",
            generationMode: "append",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            targetLength: input.targetLength,
            previousContextJson: serializeStoryContext(input.previousContext),
            previousContextOrderIndex:
              contextRow?.extractedThroughOrderIndex ?? 0,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        upsertContext(transaction, {
          storylineId: internalStorylineId,
          context: applyStoryContextPatch({
            previousContext: input.previousContext,
            patch: input.contextPatch,
            sourceRefToSegmentId: buildSourceRefToSegmentIdMap(segments, {
              currentSegmentId: String(generatedSegment.id),
            }),
          }),
          extractedThroughOrderIndex: generatedOrderIndex,
          now,
        });

        touchStoryline(transaction, internalStorylineId, now);

        return {
          storylineId: internalStorylineId,
          generatedSegmentId: generatedSegment.id,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StoryContextFailedError
      ) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveDialogueSegmentWithContext(
    input: SaveDialogueSegmentWithContextInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const segments = getSegmentsForTransaction(
          transaction,
          internalStorylineId,
        );
        const latestSegment = segments[segments.length - 1];
        if (latestSegment === undefined) {
          throw new Error("Storyline has no segments");
        }

        const contextRow = getContextForTransaction(
          transaction,
          internalStorylineId,
        );
        const now = new Date();
        const generatedOrderIndex = latestSegment.orderIndex + 1;
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: internalStorylineId,
            orderIndex: generatedOrderIndex,
            chapterIndex: latestSegment.chapterIndex,
            type: "generated",
            generationMode: "dialogue",
            text: input.generatedText.trim(),
            instruction: input.input.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousContextJson: serializeStoryContext(input.previousContext),
            previousContextOrderIndex:
              contextRow?.extractedThroughOrderIndex ?? 0,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        upsertContext(transaction, {
          storylineId: internalStorylineId,
          context: applyStoryContextPatch({
            previousContext: input.previousContext,
            patch: input.contextPatch,
            sourceRefToSegmentId: buildSourceRefToSegmentIdMap(segments, {
              currentSegmentId: String(generatedSegment.id),
            }),
          }),
          extractedThroughOrderIndex: generatedOrderIndex,
          now,
        });

        touchStoryline(transaction, internalStorylineId, now);

        return {
          storylineId: internalStorylineId,
          generatedSegmentId: generatedSegment.id,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StoryContextFailedError
      ) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveDialogueSegmentWithoutContextUpdate(
    input: SaveDialogueSegmentInput,
  ): Promise<CompletedStorylineSnapshot> {
    return this.saveGeneratedSegmentWithoutContextUpdate({
      userId: input.userId,
      storylineId: input.storylineId,
      generationMode: "dialogue",
      instruction: input.input,
      generatedText: input.generatedText,
      model: input.model,
      elapsedMs: input.elapsedMs,
      usage: input.usage,
    });
  }

  async saveRewrittenSegment(
    input: SaveRewrittenSegmentInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);
    const internalSegmentId = parseExternalId(input.segmentId);
    if (internalSegmentId === null) {
      throw new StorySegmentNotRewritableError();
    }

    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;
    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const segments = getSegmentsForTransaction(
          transaction,
          internalStorylineId,
        );
        const targetSegment = validateRewritableSegment(
          segments,
          internalSegmentId,
        );
        const contextRow = getContextForTransaction(
          transaction,
          internalStorylineId,
        );
        const now = new Date();

        transaction
          .update(storylineSegments)
          .set({
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
          })
          .where(eq(storylineSegments.id, targetSegment.id))
          .run();

        if (
          contextRow !== undefined &&
          targetSegment.orderIndex <= contextRow.extractedThroughOrderIndex
        ) {
          const previousContextOrderIndex =
            targetSegment.previousContextOrderIndex ?? 0;
          if (previousContextOrderIndex === 0) {
            transaction
              .delete(storylineContexts)
              .where(eq(storylineContexts.storylineId, internalStorylineId))
              .run();
          } else {
            upsertContext(transaction, {
              storylineId: internalStorylineId,
              context: parseSegmentPreviousContext(targetSegment),
              extractedThroughOrderIndex: previousContextOrderIndex,
              now,
            });
          }
        }

        touchStoryline(transaction, internalStorylineId, now);
        return {
          storylineId: internalStorylineId,
          generatedSegmentId: targetSegment.id,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StorySegmentNotRewritableError
      ) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveRewrittenSegmentWithContext(
    input: SaveRewrittenSegmentWithContextInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);
    const internalSegmentId = parseExternalId(input.segmentId);
    if (internalSegmentId === null) {
      throw new StorySegmentNotRewritableError();
    }

    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const segments = getSegmentsForTransaction(
          transaction,
          internalStorylineId,
        );
        const targetSegment = validateRewritableSegment(
          segments,
          internalSegmentId,
        );

        const now = new Date();
        transaction
          .update(storylineSegments)
          .set({
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
          })
          .where(eq(storylineSegments.id, targetSegment.id))
          .run();

        upsertContext(transaction, {
          storylineId: internalStorylineId,
          context: applyStoryContextPatch({
            previousContext: input.previousContext,
            patch: input.contextPatch,
            sourceRefToSegmentId: buildSourceRefToSegmentIdMap(
              segments.filter(
                (segment) => segment.orderIndex < targetSegment.orderIndex,
              ),
              { currentSegmentId: String(targetSegment.id) },
            ),
          }),
          extractedThroughOrderIndex: targetSegment.orderIndex,
          now,
        });

        touchStoryline(transaction, internalStorylineId, now);

        return {
          storylineId: internalStorylineId,
          generatedSegmentId: targetSegment.id,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StorySegmentNotRewritableError ||
        error instanceof StoryContextFailedError
      ) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  private async saveGeneratedSegmentWithoutContextUpdate(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly generationMode: StorylineGenerationMode;
    readonly instruction: string;
    readonly targetLength?: StoryTargetLength;
    readonly generatedText: string;
    readonly model: string;
    readonly elapsedMs: number;
    readonly usage: SaveAppendedSegmentInput["usage"];
  }): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseRequiredStorylineId(input.storylineId);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        assertStorylineExists(transaction, internalStorylineId, internalUserId);
        const segments = getSegmentsForTransaction(
          transaction,
          internalStorylineId,
        );
        const latestSegment = segments[segments.length - 1];
        if (latestSegment === undefined) {
          throw new Error("Storyline has no segments");
        }

        const contextRow = getContextForTransaction(
          transaction,
          internalStorylineId,
        );
        const previousContext =
          contextRow === undefined
            ? emptyStoryContextSnapshot
            : parseStoryContextRow(contextRow);
        const now = new Date();
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: internalStorylineId,
            orderIndex: latestSegment.orderIndex + 1,
            chapterIndex:
              input.generationMode === "append"
                ? latestSegment.chapterIndex + 1
                : latestSegment.chapterIndex,
            type: "generated",
            generationMode: input.generationMode,
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            ...(input.targetLength === undefined
              ? {}
              : { targetLength: input.targetLength }),
            previousContextJson: serializeStoryContext(previousContext),
            previousContextOrderIndex:
              contextRow?.extractedThroughOrderIndex ?? 0,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();
        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        touchStoryline(transaction, internalStorylineId, now);
        return {
          storylineId: internalStorylineId,
          generatedSegmentId: generatedSegment.id,
        };
      });
    } catch (error: unknown) {
      if (error instanceof StorylineNotFoundError) {
        throw error;
      }

      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  private async getRequiredStorylineForUser(
    userId: string,
    storylineId: string,
  ): Promise<StorylineRecord> {
    const storyline = await this.getStorylineForUser(userId, storylineId);
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }

    return storyline;
  }

  private async getCompletedSnapshot(
    savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>,
  ): Promise<CompletedStorylineSnapshot> {
    const snapshot = await this.getSnapshotByInternalId(savedIds.storylineId, {
      anchorPage: "latest",
      before: STORYLINE_CHAPTER_CACHE_RADIUS,
      after: 0,
    });
    if (snapshot === null) {
      throw new StorylineSaveFailedError(
        "Completed storyline snapshot missing",
      );
    }

    const latestGeneration = snapshot.latestGeneration;
    if (latestGeneration === null) {
      throw new StorylineSaveFailedError(
        "Completed storyline snapshot missing",
      );
    }

    if (latestGeneration.segmentId !== String(savedIds.generatedSegmentId)) {
      throw new StorylineSaveFailedError(
        "Completed storyline latest generation mismatch",
      );
    }

    return {
      ...snapshot,
      latestGeneration,
    };
  }

  private async getSnapshotByInternalId(
    storylineId: number,
    options: StorylineWindowOptions,
  ): Promise<StorylineSnapshot | null> {
    const [[storyline], [latestSegment], [initialSegment]] = await Promise.all([
      this.databaseService.db
        .select()
        .from(storylines)
        .where(eq(storylines.id, storylineId))
        .limit(1),
      this.databaseService.db
        .select()
        .from(storylineSegments)
        .where(eq(storylineSegments.storylineId, storylineId))
        .orderBy(desc(storylineSegments.orderIndex))
        .limit(1),
      this.databaseService.db
        .select({ text: storylineSegments.text })
        .from(storylineSegments)
        .where(
          and(
            eq(storylineSegments.storylineId, storylineId),
            eq(storylineSegments.type, "initial"),
          ),
        )
        .orderBy(storylineSegments.orderIndex)
        .limit(1),
    ]);

    if (storyline === undefined) {
      return null;
    }

    if (latestSegment === undefined) {
      throw new InternalServerErrorException("Storyline has no segments");
    }

    if (initialSegment === undefined) {
      throw new InternalServerErrorException(
        "Storyline initial segment is missing",
      );
    }

    const chapterCount = latestSegment.chapterIndex;
    const anchorPage = clampChapterPage(
      options.anchorPage === "latest" ? chapterCount : options.anchorPage,
      chapterCount,
    );
    const startPage = Math.max(
      1,
      anchorPage - clampWindowDistance(options.before),
    );
    const endPage = Math.min(
      chapterCount,
      anchorPage + clampWindowDistance(options.after),
    );
    const segments = await this.databaseService.db
      .select()
      .from(storylineSegments)
      .where(
        and(
          eq(storylineSegments.storylineId, storyline.id),
          gte(storylineSegments.chapterIndex, startPage),
          lte(storylineSegments.chapterIndex, endPage),
        ),
      )
      .orderBy(storylineSegments.orderIndex);

    return {
      id: String(storyline.id),
      title: resolveStorylineTitle({
        explicitTitle: storyline.title,
        initialText: initialSegment.text,
      }),
      chapters: mapChapterDtos(segments),
      chapterCount,
      anchorPage,
      latestGeneration:
        latestSegment.type === "generated"
          ? mapGenerationMetadata(latestSegment)
          : null,
      updatedAt: dateToIsoString(storyline.updatedAt),
    };
  }

  private async getSegmentsByInternalStorylineId(
    storylineId: number,
  ): Promise<StorylineSegmentRow[]> {
    return this.databaseService.db
      .select()
      .from(storylineSegments)
      .where(eq(storylineSegments.storylineId, storylineId))
      .orderBy(storylineSegments.orderIndex);
  }

  private async getStoryContextByInternalStorylineId(
    storylineId: number,
  ): Promise<StoryContextSnapshot | null> {
    const context =
      await this.getStoryContextRowByInternalStorylineId(storylineId);

    return context === undefined ? null : parseStoryContextRow(context);
  }

  private async getStoryContextRowByInternalStorylineId(
    storylineId: number,
  ): Promise<StorylineContextRow | undefined> {
    const [context] = await this.databaseService.db
      .select()
      .from(storylineContexts)
      .where(eq(storylineContexts.storylineId, storylineId))
      .limit(1);

    return context;
  }
}

function mapSegmentDto(segment: StorylineSegmentRow): StorylineSegmentDto {
  if (segment.type === "initial") {
    return {
      id: String(segment.id),
      type: "initial",
      text: segment.text,
    };
  }

  return {
    id: String(segment.id),
    type: "generated",
    generationMode: getRequiredGenerationMode(segment.generationMode),
    text: segment.text,
  };
}

function mapChapterDtos(
  segments: readonly StorylineSegmentRow[],
): StorylineChapter[] {
  const chapters = new Map<number, StorylineSegmentDto[]>();

  for (const segment of segments) {
    const chapterSegments = chapters.get(segment.chapterIndex) ?? [];
    chapterSegments.push(mapSegmentDto(segment));
    chapters.set(segment.chapterIndex, chapterSegments);
  }

  return [...chapters.entries()].map(([pageNumber, chapterSegments]) => ({
    pageNumber,
    segments: chapterSegments,
  }));
}

function mapListItemDto(
  storyline: Readonly<{
    id: number;
    explicitTitle: string | null;
    updatedAt: Date;
    initialText: string;
    latestText: string;
    segmentCount: number;
    chapterCount: number;
  }>,
): StorylineListItem {
  if (
    typeof storyline.initialText !== "string" ||
    storyline.initialText.length === 0
  ) {
    throw new InternalServerErrorException(
      "Storyline initial segment is missing",
    );
  }

  if (
    typeof storyline.latestText !== "string" ||
    storyline.latestText.length === 0
  ) {
    throw new InternalServerErrorException("Storyline has no latest segment");
  }

  const segmentCount = Number(storyline.segmentCount);
  const chapterCount = Number(storyline.chapterCount);
  if (
    !Number.isInteger(segmentCount) ||
    segmentCount < 1 ||
    !Number.isInteger(chapterCount) ||
    chapterCount < 1
  ) {
    throw new InternalServerErrorException("Storyline counts are invalid");
  }

  return {
    id: String(storyline.id),
    title: resolveStorylineTitle({
      explicitTitle: storyline.explicitTitle,
      initialText: storyline.initialText,
    }),
    preview: truncateSnippet(
      normalizeSnippet(storyline.latestText),
      storylineListPreviewMaxLength,
    ),
    updatedAt: dateToIsoString(storyline.updatedAt),
    segmentCount,
    chapterCount,
  };
}

function validateRewritableSegment(
  segments: readonly StorylineSegmentRow[],
  targetSegmentId: number,
): StorylineSegmentRow {
  const targetSegment = segments.find(
    (segment) => segment.id === targetSegmentId,
  );
  if (targetSegment?.type !== "generated") {
    throw new StorySegmentNotRewritableError();
  }

  const latestGeneratedSegment = [...segments]
    .reverse()
    .find((segment) => segment.type === "generated");
  if (latestGeneratedSegment?.id !== targetSegment.id) {
    throw new StorySegmentNotRewritableError();
  }

  return targetSegment;
}

function mapGeneratedRounds(
  segments: readonly StorylineSegmentRow[],
): StoryHistoryRound[] {
  return segments
    .filter((segment) => segment.type === "generated")
    .map((segment, index) => ({
      segmentId: String(segment.id),
      roundIndex: index + 1,
      generationMode: getRequiredGenerationMode(segment.generationMode),
      instruction: getRequiredString(segment.instruction, "instruction"),
      generatedText: segment.text,
    }));
}

function getEffectiveContextSegments(
  segments: readonly StorylineSegmentRow[],
): StorylineSegmentRow[] {
  return segments.filter((segment) => {
    if (segment.type !== "generated") {
      return false;
    }

    return !(
      getRequiredGenerationMode(segment.generationMode) === "dialogue" &&
      segment.text.trim() === noOpDialogueText
    );
  });
}

function getPendingContextSegments(
  segments: readonly StorylineSegmentRow[],
  extractedThroughOrderIndex: number,
): StorylineSegmentRow[] {
  return getEffectiveContextSegments(segments).filter(
    (segment) => segment.orderIndex > extractedThroughOrderIndex,
  );
}

function mapGenerationMetadata(
  segment: StorylineSegmentRow,
): StorylineGenerationMetadata {
  return {
    segmentId: String(segment.id),
    model: getRequiredString(segment.model, "model"),
    elapsedMs: getRequiredNumber(segment.elapsedMs, "elapsedMs"),
    usage: {
      inputTokens: getRequiredNumber(segment.inputTokens, "inputTokens"),
      outputTokens: getRequiredNumber(segment.outputTokens, "outputTokens"),
      totalTokens: getRequiredNumber(segment.totalTokens, "totalTokens"),
    },
  };
}

function buildWriterContextBundle(input: {
  readonly storyContext: StoryContextSnapshot;
  readonly contextWasMissing: boolean;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
  readonly searchText: string;
}): StoryWriterContextBundle {
  if (input.contextWasMissing) {
    return {
      storyContext: input.storyContext,
      observableFacts: [],
      activeCharacters: [],
      recentHistoryRounds: input.recentHistoryRounds,
      historyWasTrimmed: input.historyWasTrimmed,
      contextWasMissing: true,
    };
  }

  return {
    storyContext: input.storyContext,
    observableFacts: selectObservableFacts(input.storyContext),
    activeCharacters: selectActiveCharacters({
      storyContext: input.storyContext,
      recentHistoryRounds: input.recentHistoryRounds,
      searchText: input.searchText,
    }),
    recentHistoryRounds: input.recentHistoryRounds,
    historyWasTrimmed: input.historyWasTrimmed,
    contextWasMissing: false,
  };
}

function selectObservableFacts(
  storyContext: StoryContextSnapshot,
): StoryWorldFact[] {
  const factsById = new Map(
    storyContext.worldFacts.map((fact) => [fact.id, fact] as const),
  );
  return storyContext.currentScene.observableFactIds
    .map((factId) => factsById.get(factId))
    .filter((fact): fact is StoryWorldFact => fact !== undefined)
    .slice(0, STORY_CONTEXT_LIMITS.observableFactsForPrompt);
}

function selectActiveCharacters(input: {
  readonly storyContext: StoryContextSnapshot;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly searchText: string;
}): StoryCharacterContext[] {
  const charactersById = new Map(
    input.storyContext.characters.map(
      (character) => [character.id, character] as const,
    ),
  );
  const presentCharacters = input.storyContext.currentScene.presentCharacterIds
    .map((characterId) => charactersById.get(characterId))
    .filter(
      (character): character is StoryCharacterContext =>
        character !== undefined,
    );
  if (presentCharacters.length === 0) {
    return [];
  }

  const searchableText = normalizeContextMatchText(
    [
      input.searchText,
      input.storyContext.currentScene.sceneStatus,
      ...input.recentHistoryRounds.flatMap((round) => [
        round.instruction,
        round.generatedText,
      ]),
    ].join("\n"),
  );
  const matchedCharacters = presentCharacters.filter((character) => {
    const tokens = [character.name, ...character.aliases]
      .map(normalizeContextMatchText)
      .filter((token) => token.length > 0);
    return tokens.some((token) => searchableText.includes(token));
  });
  const activeCharacters =
    matchedCharacters.length > 0 ? matchedCharacters : presentCharacters;

  return activeCharacters.slice(0, STORY_CONTEXT_LIMITS.activeCharacters);
}

function selectRecentHistoryRounds(
  rounds: readonly StoryHistoryRound[],
  config: HistoryScoreConfig,
): Readonly<{ rounds: readonly StoryHistoryRound[]; wasTrimmed: boolean }> {
  const selectedRounds: StoryHistoryRound[] = [];
  let totalScore = 0;

  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined) {
      continue;
    }

    const roundScore = getHistoryRoundScore(round, config);
    if (
      selectedRounds.length > 0 &&
      totalScore + roundScore > config.scoreLimit
    ) {
      break;
    }

    selectedRounds.push(round);
    totalScore += roundScore;
  }

  selectedRounds.reverse();

  return {
    rounds: selectedRounds,
    wasTrimmed: selectedRounds.length < rounds.length,
  };
}

function getHistoryRoundScore(
  round: StoryHistoryRound,
  config: HistoryScoreConfig,
): number {
  return round.generationMode === "dialogue"
    ? config.dialogueScore
    : config.appendScore;
}

function buildCurrentSceneText(
  segments: readonly StorylineSegmentRow[],
): string {
  const latestChapterIndex = findLatestChapterIndex(segments);
  const latestChapter = segments[latestChapterIndex];
  if (latestChapter === undefined) {
    throw new InternalServerErrorException(
      "Storyline current scene is missing",
    );
  }

  const promptParts = ["章节正文：", latestChapter.text];
  for (const segment of segments.slice(latestChapterIndex + 1)) {
    if (segment.type !== "generated") {
      continue;
    }

    if (getRequiredGenerationMode(segment.generationMode) !== "dialogue") {
      continue;
    }

    promptParts.push("", "互动：", segment.text);
  }

  return promptParts.join("\n");
}

function findLatestChapterIndex(
  segments: readonly StorylineSegmentRow[],
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }

    if (segment.type === "initial") {
      return index;
    }

    if (getRequiredGenerationMode(segment.generationMode) === "append") {
      return index;
    }
  }

  return -1;
}

function buildSourceRefToSegmentIdMap(
  segments: readonly StorylineSegmentRow[],
  options: Readonly<{ currentSegmentId?: string }> = {},
): ReadonlyMap<string, string> {
  const mappings = new Map<string, string>();
  for (const segment of segments) {
    if (segment.type === "initial") {
      mappings.set("initial", String(segment.id));
      continue;
    }

    mappings.set(`segment:${segment.id}`, String(segment.id));
  }

  if (options.currentSegmentId !== undefined) {
    mappings.set("current", options.currentSegmentId);
  }

  return mappings;
}

function upsertContext(
  transaction: TransactionLike,
  input: Readonly<{
    storylineId: number;
    context: StoryContextSnapshot;
    extractedThroughOrderIndex: number;
    now: Date;
  }>,
): void {
  const contextJson = serializeStoryContext(input.context);
  transaction
    .insert(storylineContexts)
    .values({
      storylineId: input.storylineId,
      contextJson,
      extractedThroughOrderIndex: input.extractedThroughOrderIndex,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: storylineContexts.storylineId,
      set: {
        contextJson,
        extractedThroughOrderIndex: input.extractedThroughOrderIndex,
        updatedAt: input.now,
      },
    })
    .run();
}

type TransactionLike = Parameters<
  Parameters<DatabaseService["db"]["transaction"]>[0]
>[0];

function assertStorylineExists(
  transaction: TransactionLike,
  storylineId: number,
  userId: number,
): void {
  const storyline = transaction
    .select()
    .from(storylines)
    .where(and(eq(storylines.id, storylineId), eq(storylines.userId, userId)))
    .limit(1)
    .get();

  if (storyline === undefined) {
    throw new StorylineNotFoundError();
  }
}

function getSegmentsForTransaction(
  transaction: TransactionLike,
  storylineId: number,
): StorylineSegmentRow[] {
  return transaction
    .select()
    .from(storylineSegments)
    .where(eq(storylineSegments.storylineId, storylineId))
    .orderBy(storylineSegments.orderIndex)
    .all();
}

function getContextForTransaction(
  transaction: TransactionLike,
  storylineId: number,
): StorylineContextRow | undefined {
  return transaction
    .select()
    .from(storylineContexts)
    .where(eq(storylineContexts.storylineId, storylineId))
    .limit(1)
    .get();
}

function touchStoryline(
  transaction: TransactionLike,
  storylineId: number,
  updatedAt: Date,
): void {
  transaction
    .update(storylines)
    .set({ updatedAt })
    .where(eq(storylines.id, storylineId))
    .run();
}

function getRequiredInitialSegment(
  segments: readonly StorylineSegmentRow[],
): StorylineSegmentRow {
  const initialSegment = segments.find((segment) => segment.type === "initial");
  if (initialSegment === undefined) {
    throw new InternalServerErrorException(
      "Storyline initial segment is missing",
    );
  }

  return initialSegment;
}

function parseStoryContextRow(
  context: StorylineContextRow,
): StoryContextSnapshot {
  try {
    return parseStoryContextJson(context.contextJson);
  } catch {
    throw new InternalServerErrorException("Storyline context is invalid");
  }
}

function parseSegmentPreviousContext(
  segment: StorylineSegmentRow,
): StoryContextSnapshot {
  if (segment.type !== "generated") {
    throw new StorylineSaveFailedError(
      "Storyline generated segment is missing previous context",
    );
  }

  if (segment.previousContextJson === null) {
    return emptyStoryContextSnapshot;
  }

  return parseStoryContextJson(segment.previousContextJson);
}

function parseRequiredStorylineId(value: string): number {
  const internalStorylineId = parseExternalId(value);
  if (internalStorylineId === null) {
    throw new StorylineNotFoundError();
  }

  return internalStorylineId;
}

function getRequiredString(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new InternalServerErrorException(
      `Storyline generated segment is missing ${field}`,
    );
  }

  return value;
}

function getNullableString(value: string | null): string {
  return value ?? "";
}

function getRequiredNumber(value: number | null, field: string): number {
  if (value === null || !Number.isInteger(value) || value < 0) {
    throw new InternalServerErrorException(
      `Storyline generated segment is missing ${field}`,
    );
  }

  return value;
}

function getOptionalTargetLength(
  value: number | null,
): StoryTargetLength | undefined {
  if (
    value === null ||
    !Number.isInteger(value) ||
    value < 100 ||
    value > 1_200
  ) {
    return undefined;
  }

  return value;
}

function getRequiredGenerationMode(
  value: StorylineGenerationMode | null,
): StorylineGenerationMode {
  if (value !== "append" && value !== "dialogue") {
    throw new InternalServerErrorException(
      "Storyline generated segment is missing generation mode",
    );
  }

  return value;
}

function clampChapterPage(page: number, chapterCount: number): number {
  if (!Number.isFinite(page)) {
    return chapterCount;
  }

  return Math.min(Math.max(Math.trunc(page), 1), chapterCount);
}

function clampWindowDistance(distance: number): number {
  if (!Number.isFinite(distance)) {
    return STORYLINE_CHAPTER_CACHE_RADIUS;
  }

  return Math.min(
    Math.max(Math.trunc(distance), 0),
    STORYLINE_CHAPTER_CACHE_RADIUS,
  );
}

function parseAuthenticatedUserId(userId: string): number {
  const parsedUserId = parseExternalId(userId);
  if (parsedUserId === null) {
    throw new UnauthorizedException("Invalid authenticated user");
  }

  return parsedUserId;
}

function parseExternalId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

function dateToIsoString(value: Date): string {
  return value.toISOString();
}

function normalizeSnippet(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateSnippet(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
