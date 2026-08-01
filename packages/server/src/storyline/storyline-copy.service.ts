import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  CopyStorylineRequestSchema,
  STORYLINE_CHAPTER_CACHE_RADIUS,
} from "@kimiko/schema";
import type {
  CopyStorylineRequest,
  CopyStorylineResponse,
  StoryContextSnapshot,
} from "@kimiko/schema";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import {
  storylineContexts,
  storylineSegments,
  storylines,
} from "../database/schema";
import { remapStoryContextSegmentIds } from "./storyline-context-remap";
import {
  parseStoryContextJson,
  serializeStoryContext,
} from "./storyline-context-normalize";
import {
  StorylineCopyChapterOutOfRangeError,
  StorylineCopyFailedError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

type StorylineSegmentRow = typeof storylineSegments.$inferSelect;
type StorylineContextRow = typeof storylineContexts.$inferSelect;

interface CopyTransactionResult {
  readonly copiedSegmentCount: number;
  readonly copiedStorylineId: number;
  readonly throughChapter: number;
}

interface PrefixContext {
  readonly context: StoryContextSnapshot;
  readonly extractedThroughOrderIndex: number;
}

@Injectable()
export class StorylineCopyService {
  private readonly logger = new Logger(StorylineCopyService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly lockService: StorylineLockService,
    private readonly storylineService: StorylineService,
  ) {}

  async copyStoryline(input: {
    readonly body: unknown;
    readonly sourceStorylineId: string;
    readonly userId: string;
  }): Promise<CopyStorylineResponse> {
    const request = parseCopyRequest(input.body);
    const sourceStoryline = await this.storylineService.getStorylineForUser(
      input.userId,
      input.sourceStorylineId,
    );
    if (sourceStoryline === null) {
      throw new StorylineNotFoundError();
    }

    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = this.lockService.acquireStorylineLock(
        sourceStoryline.externalId,
      );
      const result = this.runCopyTransaction({
        internalSourceStorylineId: sourceStoryline.id,
        internalUserId: sourceStoryline.userId,
        request,
      });
      const snapshot = await this.storylineService.getStorylineSnapshotForUser(
        input.userId,
        String(result.copiedStorylineId),
        {
          anchorPage: "latest",
          before: STORYLINE_CHAPTER_CACHE_RADIUS,
          after: 0,
        },
      );
      if (snapshot === null) {
        throw new StorylineCopyFailedError(
          "Copied storyline snapshot is missing",
        );
      }

      this.logger.log(
        JSON.stringify({
          event: "storyline_copy_completed",
          sourceStorylineId: sourceStoryline.externalId,
          copiedStorylineId: String(result.copiedStorylineId),
          throughChapter: result.throughChapter,
          copiedSegmentCount: result.copiedSegmentCount,
          userId: input.userId,
        }),
      );

      return { storyline: snapshot };
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({
          event: "storyline_copy_failed",
          sourceStorylineId: sourceStoryline.externalId,
          throughChapter: request.throughChapter,
          userId: input.userId,
          errorName:
            error instanceof Error ? error.name : "UnknownStorylineCopyError",
        }),
      );
      throw error;
    } finally {
      releaseLock?.();
    }
  }

  private runCopyTransaction(input: {
    readonly internalSourceStorylineId: number;
    readonly internalUserId: number;
    readonly request: CopyStorylineRequest;
  }): CopyTransactionResult {
    try {
      return this.databaseService.db.transaction((transaction) => {
        const sourceStoryline = transaction
          .select()
          .from(storylines)
          .where(
            and(
              eq(storylines.id, input.internalSourceStorylineId),
              eq(storylines.userId, input.internalUserId),
            ),
          )
          .limit(1)
          .get();
        if (sourceStoryline === undefined) {
          throw new StorylineNotFoundError();
        }

        const sourceSegments = transaction
          .select()
          .from(storylineSegments)
          .where(
            eq(storylineSegments.storylineId, input.internalSourceStorylineId),
          )
          .orderBy(storylineSegments.orderIndex)
          .all();
        const latestSourceSegment = sourceSegments.at(-1);
        if (
          latestSourceSegment === undefined ||
          !sourceSegments.some((segment) => segment.type === "initial")
        ) {
          throw new StorylineCopyFailedError(
            "Source storyline has no valid segments",
          );
        }

        const sourceChapterCount = latestSourceSegment.chapterIndex;
        if (input.request.throughChapter > sourceChapterCount) {
          throw new StorylineCopyChapterOutOfRangeError();
        }

        const sourcePrefixSegments = sourceSegments.filter(
          (segment) => segment.chapterIndex <= input.request.throughChapter,
        );
        const lastPrefixSegment = sourcePrefixSegments.at(-1);
        if (lastPrefixSegment?.chapterIndex !== input.request.throughChapter) {
          throw new StorylineCopyFailedError(
            "Source storyline chapter sequence is invalid",
          );
        }

        const sourceContext = transaction
          .select()
          .from(storylineContexts)
          .where(
            eq(storylineContexts.storylineId, input.internalSourceStorylineId),
          )
          .limit(1)
          .get();
        const now = new Date();
        const copiedStoryline = transaction
          .insert(storylines)
          .values({
            userId: input.internalUserId,
            title: input.request.title,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: storylines.id })
          .get();
        if (copiedStoryline === undefined) {
          throw new StorylineCopyFailedError(
            "Failed to insert copied storyline",
          );
        }

        const segmentIdMap = new Map<string, string>();
        const copiedSegmentIdBySourceId = new Map<number, number>();
        for (const sourceSegment of sourcePrefixSegments) {
          const copiedSegment = transaction
            .insert(storylineSegments)
            .values({
              storylineId: copiedStoryline.id,
              orderIndex: sourceSegment.orderIndex,
              chapterIndex: sourceSegment.chapterIndex,
              type: sourceSegment.type,
              generationMode: sourceSegment.generationMode,
              text: sourceSegment.text,
              instruction: sourceSegment.instruction,
              model: sourceSegment.model,
              elapsedMs: sourceSegment.elapsedMs,
              inputTokens: sourceSegment.inputTokens,
              outputTokens: sourceSegment.outputTokens,
              totalTokens: sourceSegment.totalTokens,
              targetLength: sourceSegment.targetLength,
              previousContextJson: null,
              previousContextOrderIndex:
                sourceSegment.previousContextOrderIndex,
              createdAt: now,
            })
            .returning({ id: storylineSegments.id })
            .get();
          if (copiedSegment === undefined) {
            throw new StorylineCopyFailedError(
              "Failed to insert copied storyline segment",
            );
          }

          segmentIdMap.set(String(sourceSegment.id), String(copiedSegment.id));
          copiedSegmentIdBySourceId.set(sourceSegment.id, copiedSegment.id);
        }

        for (const sourceSegment of sourcePrefixSegments) {
          if (
            sourceSegment.type !== "generated" ||
            sourceSegment.previousContextJson === null
          ) {
            continue;
          }

          const copiedSegmentId = copiedSegmentIdBySourceId.get(
            sourceSegment.id,
          );
          if (copiedSegmentId === undefined) {
            throw new StorylineCopyFailedError(
              "Copied storyline segment mapping is missing",
            );
          }

          const previousContext = remapStoryContextSegmentIds({
            context: parseStoryContextJson(sourceSegment.previousContextJson),
            segmentIdMap,
          });
          transaction
            .update(storylineSegments)
            .set({
              previousContextJson: serializeStoryContext(previousContext),
            })
            .where(eq(storylineSegments.id, copiedSegmentId))
            .run();
        }

        const prefixContext = selectPrefixContext({
          cutoffOrderIndex: lastPrefixSegment.orderIndex,
          sourceContext,
          sourceSegments,
        });
        if (prefixContext !== null) {
          const copiedContext = remapStoryContextSegmentIds({
            context: prefixContext.context,
            segmentIdMap,
          });
          transaction
            .insert(storylineContexts)
            .values({
              storylineId: copiedStoryline.id,
              contextJson: serializeStoryContext(copiedContext),
              extractedThroughOrderIndex:
                prefixContext.extractedThroughOrderIndex,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }

        return {
          copiedStorylineId: copiedStoryline.id,
          copiedSegmentCount: sourcePrefixSegments.length,
          throughChapter: input.request.throughChapter,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof StorylineNotFoundError ||
        error instanceof StorylineCopyChapterOutOfRangeError ||
        error instanceof StorylineCopyFailedError
      ) {
        throw error;
      }

      throw new StorylineCopyFailedError(toErrorMessage(error));
    }
  }
}

function selectPrefixContext(input: {
  readonly cutoffOrderIndex: number;
  readonly sourceContext: StorylineContextRow | undefined;
  readonly sourceSegments: readonly StorylineSegmentRow[];
}): PrefixContext | null {
  if (input.sourceContext === undefined) {
    return null;
  }

  if (
    input.sourceContext.extractedThroughOrderIndex <= input.cutoffOrderIndex
  ) {
    if (input.sourceContext.extractedThroughOrderIndex === 0) {
      return null;
    }

    return {
      context: parseStoryContextJson(input.sourceContext.contextJson),
      extractedThroughOrderIndex:
        input.sourceContext.extractedThroughOrderIndex,
    };
  }

  const firstExcludedSegment = input.sourceSegments.find(
    (segment) =>
      segment.orderIndex > input.cutoffOrderIndex &&
      segment.type === "generated",
  );
  if (firstExcludedSegment === undefined) {
    throw new StorylineCopyFailedError(
      "Story context is ahead of the copied prefix",
    );
  }

  const previousContextOrderIndex =
    firstExcludedSegment.previousContextOrderIndex ?? 0;
  if (
    previousContextOrderIndex === 0 ||
    firstExcludedSegment.previousContextJson === null
  ) {
    return null;
  }

  if (previousContextOrderIndex > input.cutoffOrderIndex) {
    throw new StorylineCopyFailedError(
      "Safe story context is ahead of the copied prefix",
    );
  }

  return {
    context: parseStoryContextJson(firstExcludedSegment.previousContextJson),
    extractedThroughOrderIndex: previousContextOrderIndex,
  };
}

function parseCopyRequest(body: unknown): CopyStorylineRequest {
  const result = CopyStorylineRequestSchema.safeParse(body);
  if (result.success) {
    return result.data;
  }

  throw new BadRequestException({
    message: "Invalid request body",
    issues: result.error.issues,
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
