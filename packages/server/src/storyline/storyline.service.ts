import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  CompletedStorylineSnapshot,
  GetRecentStorylineResponse,
  StorylineGenerationMetadata,
  StorylineSegment as StorylineSegmentDto,
  StorylineSnapshot,
} from "@kimiko/schema";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { storylineSegments, storylines } from "../database/schema";
import type { StoryLlmContext, StoryHistoryRound } from "../story/story.service";
import { StorylineNotFoundError, StorylineSaveFailedError } from "./storyline.errors";
import type {
  SaveAppendedSegmentInput,
  SaveCreatedStorylineInput,
  StorylineRecord,
} from "./storyline.types";

type StorylineSegmentRow = typeof storylineSegments.$inferSelect;

@Injectable()
export class StorylineService {
  constructor(private readonly databaseService: DatabaseService) {}

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

    return {
      currentInstruction: input.currentInstruction,
      ...(historyWasTrimmed ? {} : { initialStoryText: initialSegment.text }),
      historyRounds,
      historyWasTrimmed,
    };
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

  async saveAppendedSegment(
    input: SaveAppendedSegmentInput,
  ): Promise<CompletedStorylineSnapshot> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalStorylineId = parseExternalId(input.storylineId);
    if (internalStorylineId === null) {
      throw new StorylineNotFoundError();
    }

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
}

function mapSegmentDto(segment: StorylineSegmentRow): StorylineSegmentDto {
  return {
    id: String(segment.id),
    type: segment.type,
    text: segment.text,
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
