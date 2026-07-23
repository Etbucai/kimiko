import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  CompletedStorylineSnapshot,
  GetRecentStorylineResponse,
  ListStorylinesResponse,
  StorylineGenerationMetadata,
  StorylineListItem,
  StorylineSegment as StorylineSegmentDto,
  StorylineSnapshot,
} from "@kimiko/schema";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import {
  storylineSegments,
  storylineSummaries,
  storylines,
} from "../database/schema";
import type {
  StoryHistoryRound,
  StoryLlmContext,
  StoryRewriteLlmContext,
} from "../story/story.service";
import {
  StorySegmentNotRewritableError,
  StorylineNotFoundError,
  StorylineSaveFailedError,
} from "./storyline.errors";
import {
  emptyCharacterSummarySnapshot,
  StoryCharacterSummarySnapshotSchema,
  type StoryCharacterSummarySnapshot,
} from "./storyline-summary.types";
import type {
  SaveAppendedSegmentInput,
  SaveAppendedSegmentWithSummaryInput,
  SaveCreatedStorylineInput,
  SaveCreatedStorylineWithSummaryInput,
  SaveRewrittenSegmentWithSummaryInput,
  StorylineRewriteContext,
  StorylineRecord,
} from "./storyline.types";

type StorylineRow = typeof storylines.$inferSelect;
type StorylineSegmentRow = typeof storylineSegments.$inferSelect;
type StorylineSummaryRow = typeof storylineSummaries.$inferSelect;

const storylineListLimit = 50;
const storylineListTitleMaxLength = 80;
const storylineListPreviewMaxLength = 240;

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
        const segments = await this.getSegmentsByInternalStorylineId(
          storyline.id,
        );

        return mapListItemDto(storyline, segments);
      }),
    );

    return { storylines: items };
  }

  async getRecentStoryline(
    userId: string,
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

    const snapshot = await this.getSnapshotByInternalId(storyline.id);
    if (snapshot === null) {
      throw new InternalServerErrorException("Storyline snapshot is missing");
    }

    return { storyline: snapshot };
  }

  async getStorylineSnapshotForUser(
    userId: string,
    storylineId: string,
  ): Promise<StorylineSnapshot | null> {
    const storyline = await this.getStorylineForUser(userId, storylineId);
    if (storyline === null) {
      return null;
    }

    const snapshot = await this.getSnapshotByInternalId(storyline.id);
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
    readonly historyRoundLimit: number;
  }): Promise<StoryLlmContext> {
    const storyline = await this.getStorylineForUser(
      input.userId,
      input.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }

    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    const initialSegment = segments.find((segment) => segment.type === "initial");
    if (initialSegment === undefined) {
      throw new InternalServerErrorException(
        "Storyline initial segment is missing",
      );
    }

    const generatedRounds = mapGeneratedRounds(segments);
    const historyWasTrimmed = generatedRounds.length > input.historyRoundLimit;
    const historyRounds = historyWasTrimmed
      ? generatedRounds.slice(-input.historyRoundLimit)
      : generatedRounds;
    const characterSummary = await this.getCharacterSummaryByInternalStorylineId(
      storyline.id,
    );

    return {
      currentInstruction: input.currentInstruction,
      ...(historyWasTrimmed ? {} : { initialStoryText: initialSegment.text }),
      ...(characterSummary !== null ? { characterSummary } : {}),
      historyRounds,
      historyWasTrimmed,
    };
  }

  async buildRewriteLlmContext(input: {
    readonly userId: string;
    readonly storylineId: string;
    readonly segmentId: string;
    readonly rewriteInstruction: string;
    readonly historyRoundLimit: number;
  }): Promise<StorylineRewriteContext> {
    const storyline = await this.getStorylineForUser(
      input.userId,
      input.storylineId,
    );
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }

    const targetSegmentId = parseExternalId(input.segmentId);
    if (targetSegmentId === null) {
      throw new StorySegmentNotRewritableError();
    }

    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    const initialSegment = segments.find((segment) => segment.type === "initial");
    if (initialSegment === undefined) {
      throw new InternalServerErrorException(
        "Storyline initial segment is missing",
      );
    }

    const targetSegment = validateRewritableSegment(segments, targetSegmentId);
    const previousSummary = parseSegmentPreviousSummary(targetSegment);
    const generatedSegmentsBeforeTarget = segments.filter(
      (segment) =>
        segment.type === "generated" &&
        segment.orderIndex < targetSegment.orderIndex,
    );
    const generatedRoundsBeforeTarget = mapGeneratedRounds(
      generatedSegmentsBeforeTarget,
    );
    const historyWasTrimmed =
      generatedRoundsBeforeTarget.length > input.historyRoundLimit;
    const historyRoundsBeforeTarget = historyWasTrimmed
      ? generatedRoundsBeforeTarget.slice(-input.historyRoundLimit)
      : generatedRoundsBeforeTarget;
    const writerContext: StoryRewriteLlmContext = {
      rewriteInstruction: input.rewriteInstruction,
      originalInstruction: getRequiredString(
        targetSegment.instruction,
        "instruction",
      ),
      originalGeneratedText: targetSegment.text,
      ...(historyWasTrimmed ? {} : { initialStoryText: initialSegment.text }),
      ...(previousSummary.characters.length > 0
        ? { characterSummary: previousSummary }
        : {}),
      historyRoundsBeforeTarget,
      historyWasTrimmed,
    };

    return {
      storyline,
      targetSegmentId: String(targetSegment.id),
      previousSummary,
      writerContext,
      summaryHistoryRounds: historyRoundsBeforeTarget,
      ...(historyWasTrimmed ? {} : { initialStoryText: initialSegment.text }),
    };
  }

  async getCharacterSummaryForUser(
    userId: string,
    storylineId: string,
  ): Promise<StoryCharacterSummarySnapshot | null> {
    const storyline = await this.getStorylineForUser(userId, storylineId);
    if (storyline === null) {
      throw new StorylineNotFoundError();
    }

    return this.getCharacterSummaryByInternalStorylineId(storyline.id);
  }

  async saveCreatedStoryline(
    input: SaveCreatedStorylineInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const previousSummaryJson = serializeCharacterSummary(
      emptyCharacterSummarySnapshot,
    );
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

        transaction.insert(storylineSegments).values({
          storylineId: createdStoryline.id,
          orderIndex: 0,
          type: "initial",
          text: input.initialStoryText.trim(),
          createdAt: now,
        }).run();

        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 1,
            type: "generated",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousSummaryJson,
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

  async saveCreatedStorylineWithSummary(
    input: SaveCreatedStorylineWithSummaryInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const charactersJson = serializeCharacterSummary(input.characterSummary);
    const previousSummaryJson = serializeCharacterSummary(
      emptyCharacterSummarySnapshot,
    );
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
            type: "initial",
            text: input.initialStoryText.trim(),
            createdAt: now,
          })
          .run();

        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: createdStoryline.id,
            orderIndex: 1,
            type: "generated",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousSummaryJson,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        transaction
          .insert(storylineSummaries)
          .values({
            storylineId: createdStoryline.id,
            charactersJson,
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
      throw new StorylineSaveFailedError(toErrorMessage(error));
    }

    return this.getCompletedSnapshot(savedIds);
  }

  async saveAppendedSegment(
    input: SaveAppendedSegmentInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseExternalId(input.storylineId);
    if (internalStorylineId === null) {
      throw new StorylineNotFoundError();
    }

    const previousSummaryJson = serializeCharacterSummary(
      emptyCharacterSummarySnapshot,
    );
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        const storyline = transaction
          .select()
          .from(storylines)
          .where(
            and(
              eq(storylines.id, internalStorylineId),
              eq(storylines.userId, internalUserId),
            ),
          )
          .limit(1)
          .get();

        if (storyline === undefined) {
          throw new StorylineNotFoundError();
        }

        const latestSegment = transaction
          .select({ orderIndex: storylineSegments.orderIndex })
          .from(storylineSegments)
          .where(eq(storylineSegments.storylineId, internalStorylineId))
          .orderBy(desc(storylineSegments.orderIndex))
          .limit(1)
          .get();

        if (latestSegment === undefined) {
          throw new Error("Storyline has no segments");
        }

        const now = new Date();
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: internalStorylineId,
            orderIndex: latestSegment.orderIndex + 1,
            type: "generated",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousSummaryJson,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        transaction
          .update(storylines)
          .set({ updatedAt: now })
          .where(eq(storylines.id, internalStorylineId))
          .run();

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

  async saveAppendedSegmentWithSummary(
    input: SaveAppendedSegmentWithSummaryInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseExternalId(input.storylineId);
    if (internalStorylineId === null) {
      throw new StorylineNotFoundError();
    }

    const charactersJson = serializeCharacterSummary(input.characterSummary);
    const previousSummaryJson = serializeCharacterSummary(input.previousSummary);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        const storyline = transaction
          .select()
          .from(storylines)
          .where(
            and(
              eq(storylines.id, internalStorylineId),
              eq(storylines.userId, internalUserId),
            ),
          )
          .limit(1)
          .get();

        if (storyline === undefined) {
          throw new StorylineNotFoundError();
        }

        const latestSegment = transaction
          .select({ orderIndex: storylineSegments.orderIndex })
          .from(storylineSegments)
          .where(eq(storylineSegments.storylineId, internalStorylineId))
          .orderBy(desc(storylineSegments.orderIndex))
          .limit(1)
          .get();

        if (latestSegment === undefined) {
          throw new Error("Storyline has no segments");
        }

        const now = new Date();
        const generatedSegment = transaction
          .insert(storylineSegments)
          .values({
            storylineId: internalStorylineId,
            orderIndex: latestSegment.orderIndex + 1,
            type: "generated",
            text: input.generatedText.trim(),
            instruction: input.instruction.trim(),
            model: input.model,
            elapsedMs: input.elapsedMs,
            inputTokens: input.usage.inputTokens,
            outputTokens: input.usage.outputTokens,
            totalTokens: input.usage.totalTokens,
            previousSummaryJson,
            createdAt: now,
          })
          .returning({ id: storylineSegments.id })
          .get();

        if (generatedSegment === undefined) {
          throw new Error("Failed to insert generated segment");
        }

        transaction
          .insert(storylineSummaries)
          .values({
            storylineId: internalStorylineId,
            charactersJson,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: storylineSummaries.storylineId,
            set: {
              charactersJson,
              updatedAt: now,
            },
          })
          .run();

        transaction
          .update(storylines)
          .set({ updatedAt: now })
          .where(eq(storylines.id, internalStorylineId))
          .run();

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

  async saveRewrittenSegmentWithSummary(
    input: SaveRewrittenSegmentWithSummaryInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseExternalId(input.storylineId);
    if (internalStorylineId === null) {
      throw new StorylineNotFoundError();
    }

    const internalSegmentId = parseExternalId(input.segmentId);
    if (internalSegmentId === null) {
      throw new StorySegmentNotRewritableError();
    }

    const charactersJson = serializeCharacterSummary(input.characterSummary);
    let savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>;

    try {
      savedIds = this.databaseService.db.transaction((transaction) => {
        const storyline = transaction
          .select()
          .from(storylines)
          .where(
            and(
              eq(storylines.id, internalStorylineId),
              eq(storylines.userId, internalUserId),
            ),
          )
          .limit(1)
          .get();

        if (storyline === undefined) {
          throw new StorylineNotFoundError();
        }

        const segments = transaction
          .select()
          .from(storylineSegments)
          .where(eq(storylineSegments.storylineId, internalStorylineId))
          .orderBy(storylineSegments.orderIndex)
          .all();
        const targetSegment = validateRewritableSegment(
          segments,
          internalSegmentId,
        );
        parseSegmentPreviousSummary(targetSegment);

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

        transaction
          .insert(storylineSummaries)
          .values({
            storylineId: internalStorylineId,
            charactersJson,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: storylineSummaries.storylineId,
            set: {
              charactersJson,
              updatedAt: now,
            },
          })
          .run();

        transaction
          .update(storylines)
          .set({ updatedAt: now })
          .where(eq(storylines.id, internalStorylineId))
          .run();

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

  private async getCompletedSnapshot(
    savedIds: Readonly<{ storylineId: number; generatedSegmentId: number }>,
  ): Promise<CompletedStorylineSnapshot> {
    const snapshot = await this.getSnapshotByInternalId(savedIds.storylineId);
    if (snapshot === null) {
      throw new StorylineSaveFailedError("Completed storyline snapshot missing");
    }

    const latestGeneration = snapshot.latestGeneration;
    if (latestGeneration === null) {
      throw new StorylineSaveFailedError("Completed storyline snapshot missing");
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
  ): Promise<StorylineSnapshot | null> {
    const [storyline] = await this.databaseService.db
      .select()
      .from(storylines)
      .where(eq(storylines.id, storylineId))
      .limit(1);

    if (storyline === undefined) {
      return null;
    }

    const segments = await this.getSegmentsByInternalStorylineId(storyline.id);
    if (segments.length === 0) {
      throw new InternalServerErrorException("Storyline has no segments");
    }

    return {
      id: String(storyline.id),
      segments: segments.map(mapSegmentDto),
      latestGeneration: getLatestGenerationMetadata(segments),
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

  private async getCharacterSummaryByInternalStorylineId(
    storylineId: number,
  ): Promise<StoryCharacterSummarySnapshot | null> {
    const [summary] = await this.databaseService.db
      .select()
      .from(storylineSummaries)
      .where(eq(storylineSummaries.storylineId, storylineId))
      .limit(1);

    return summary === undefined ? null : parseCharacterSummary(summary);
  }
}

function mapSegmentDto(segment: StorylineSegmentRow): StorylineSegmentDto {
  return {
    id: String(segment.id),
    type: segment.type,
    text: segment.text,
  };
}

function mapListItemDto(
  storyline: StorylineRow,
  segments: readonly StorylineSegmentRow[],
): StorylineListItem {
  if (segments.length === 0) {
    throw new InternalServerErrorException("Storyline has no segments");
  }

  const initialSegment = segments.find((segment) => segment.type === "initial");
  if (initialSegment === undefined) {
    throw new InternalServerErrorException(
      "Storyline initial segment is missing",
    );
  }

  const latestSegment = segments[segments.length - 1];
  if (latestSegment === undefined) {
    throw new InternalServerErrorException("Storyline has no latest segment");
  }

  return {
    id: String(storyline.id),
    title: truncateSnippet(
      getFirstNonEmptyLine(initialSegment.text),
      storylineListTitleMaxLength,
    ),
    preview: truncateSnippet(
      normalizeSnippet(latestSegment.text),
      storylineListPreviewMaxLength,
    ),
    updatedAt: dateToIsoString(storyline.updatedAt),
    segmentCount: segments.length,
  };
}

function getLatestGenerationMetadata(
  segments: readonly StorylineSegmentRow[],
): StorylineGenerationMetadata | null {
  const latestGeneratedSegment = [...segments]
    .reverse()
    .find((segment) => segment.type === "generated");

  if (latestGeneratedSegment === undefined) {
    return null;
  }

  return mapGenerationMetadata(latestGeneratedSegment);
}

function validateRewritableSegment(
  segments: readonly StorylineSegmentRow[],
  targetSegmentId: number,
): StorylineSegmentRow {
  const targetSegment = segments.find((segment) => segment.id === targetSegmentId);
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
      roundIndex: index + 1,
      instruction: getRequiredString(segment.instruction, "instruction"),
      generatedText: segment.text,
    }));
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

function getRequiredString(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new InternalServerErrorException(
      `Storyline generated segment is missing ${field}`,
    );
  }

  return value;
}

function getRequiredNumber(value: number | null, field: string): number {
  if (value === null || !Number.isInteger(value) || value < 0) {
    throw new InternalServerErrorException(
      `Storyline generated segment is missing ${field}`,
    );
  }

  return value;
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

function getFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map(normalizeSnippet)
    .find((line) => line.length > 0);

  return firstLine ?? normalizeSnippet(value);
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

function parseCharacterSummary(
  summary: StorylineSummaryRow,
): StoryCharacterSummarySnapshot {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(summary.charactersJson) as unknown;
  } catch {
    throw new InternalServerErrorException("Storyline summary is invalid");
  }

  const result = StoryCharacterSummarySnapshotSchema.safeParse(parsedValue);
  if (!result.success) {
    throw new InternalServerErrorException("Storyline summary is invalid");
  }

  return result.data;
}

function serializeCharacterSummary(
  summary: StoryCharacterSummarySnapshot,
): string {
  const result = StoryCharacterSummarySnapshotSchema.safeParse(summary);
  if (!result.success) {
    throw new StorylineSaveFailedError("Storyline summary is invalid");
  }

  return JSON.stringify(result.data);
}

function parseSegmentPreviousSummary(
  segment: StorylineSegmentRow,
): StoryCharacterSummarySnapshot {
  const previousSummaryJson = segment.previousSummaryJson;
  if (segment.type !== "generated" || previousSummaryJson === null) {
    throw new StorylineSaveFailedError(
      "Storyline generated segment is missing previous summary",
    );
  }

  return parseCharacterSummaryJson(previousSummaryJson);
}

function parseCharacterSummaryJson(value: string): StoryCharacterSummarySnapshot {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value) as unknown;
  } catch {
    throw new StorylineSaveFailedError("Storyline summary is invalid");
  }

  const result = StoryCharacterSummarySnapshotSchema.safeParse(parsedValue);
  if (!result.success) {
    throw new StorylineSaveFailedError("Storyline summary is invalid");
  }

  return result.data;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
