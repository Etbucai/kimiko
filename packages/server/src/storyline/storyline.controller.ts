import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
  Param,
} from "@nestjs/common";
import type {
  CancelStoryGenerationResponse,
  CopyStorylineResponse,
  GetRecentStorylineResponse,
  GetStorylineContextResponse,
  GetStorylineResponse,
  ListStorylinesResponse,
  StoryGenerationStatusResponse,
  StoryContextExtractionTaskResponse,
} from "@kimiko/schema";
import { STORYLINE_CHAPTER_CACHE_RADIUS } from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  StorylineBusyError,
  StorylineCopyChapterOutOfRangeError,
  StorylineNotFoundError,
} from "./storyline.errors";
import { StorylineCopyService } from "./storyline-copy.service";
import { STORY_CONTEXT_AUTO_TRIGGER_ROUND_COUNT } from "./storyline-context-extraction.types";
import { StoryContextExtractionTaskService } from "./story-context-extraction-task.service";
import { StoryGenerationTaskService } from "./story-generation-task.service";
import {
  StorylineService,
  type StorylineWindowOptions,
} from "./storyline.service";

@Controller("storylines")
export class StorylineController {
  constructor(
    private readonly storylineService: StorylineService,
    private readonly storylineCopyService: StorylineCopyService,
    private readonly taskService: StoryGenerationTaskService,
    private readonly contextExtractionTaskService: StoryContextExtractionTaskService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ListStorylinesResponse> {
    return this.storylineService.listStorylines(user.userId);
  }

  @Get("recent")
  @UseGuards(JwtAuthGuard)
  getRecent(
    @CurrentUser() user: AuthenticatedUser,
    @Query("anchorPage") anchorPage: string | undefined,
    @Query("before") before: string | undefined,
    @Query("after") after: string | undefined,
  ): Promise<GetRecentStorylineResponse> {
    return this.storylineService.getRecentStoryline(
      user.userId,
      parseStorylineWindowOptions({ anchorPage, before, after }),
    );
  }

  @Post(":storylineId/copies")
  @UseGuards(JwtAuthGuard)
  async copy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
    @Body() body: unknown,
  ): Promise<CopyStorylineResponse> {
    try {
      return await this.storylineCopyService.copyStoryline({
        body,
        sourceStorylineId: storylineId,
        userId: user.userId,
      });
    } catch (error: unknown) {
      throw mapStorylineHttpError(error);
    }
  }

  @Get(":storylineId/generation/status")
  @UseGuards(JwtAuthGuard)
  async getGenerationStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<StoryGenerationStatusResponse> {
    await this.assertStorylineExists(user.userId, storylineId);

    return this.taskService.getStorylineTaskStatus({
      userId: user.userId,
      storylineId,
    });
  }

  @Post(":storylineId/generation/cancel")
  @UseGuards(JwtAuthGuard)
  async cancelGeneration(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<CancelStoryGenerationResponse> {
    await this.assertStorylineExists(user.userId, storylineId);

    return this.taskService.cancelByStoryline({
      userId: user.userId,
      storylineId,
    });
  }

  @Get(":storylineId/context")
  @UseGuards(JwtAuthGuard)
  async getContext(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<GetStorylineContextResponse> {
    try {
      const state = await this.storylineService.getStoryContextExtractionState(
        user.userId,
        storylineId,
      );

      return {
        context: state.context,
        extraction: {
          autoTriggerRoundCount: STORY_CONTEXT_AUTO_TRIGGER_ROUND_COUNT,
          pendingRoundCount: state.pendingRoundCount,
        },
      };
    } catch (error: unknown) {
      throw mapStorylineHttpError(error);
    }
  }

  @Post(":storylineId/context/extraction")
  @UseGuards(JwtAuthGuard)
  async startContextExtraction(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<StoryContextExtractionTaskResponse> {
    await this.assertStorylineExists(user.userId, storylineId);

    try {
      return await this.contextExtractionTaskService.start({
        userId: user.userId,
        storylineId,
      });
    } catch (error: unknown) {
      throw mapStorylineHttpError(error);
    }
  }

  @Get(":storylineId/context/extraction/status")
  @UseGuards(JwtAuthGuard)
  async getContextExtractionStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<StoryContextExtractionTaskResponse> {
    await this.assertStorylineExists(user.userId, storylineId);

    return this.contextExtractionTaskService.getStatus({
      userId: user.userId,
      storylineId,
    });
  }

  @Get(":storylineId")
  @UseGuards(JwtAuthGuard)
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
    @Query("anchorPage") anchorPage: string | undefined,
    @Query("before") before: string | undefined,
    @Query("after") after: string | undefined,
  ): Promise<GetStorylineResponse> {
    const storyline = await this.storylineService.getStorylineSnapshotForUser(
      user.userId,
      storylineId,
      parseStorylineWindowOptions({ anchorPage, before, after }),
    );

    if (storyline === null) {
      throw new NotFoundException("Storyline not found");
    }

    return { storyline };
  }

  private async assertStorylineExists(
    userId: string,
    storylineId: string,
  ): Promise<void> {
    const storyline = await this.storylineService.getStorylineForUser(
      userId,
      storylineId,
    );
    if (storyline === null) {
      throw new NotFoundException("Storyline not found");
    }
  }
}

function parseStorylineWindowOptions(input: {
  readonly anchorPage: string | undefined;
  readonly before: string | undefined;
  readonly after: string | undefined;
}): StorylineWindowOptions {
  return {
    anchorPage: parseAnchorPage(input.anchorPage),
    before: parseWindowDistance(input.before),
    after: parseWindowDistance(input.after),
  };
}

function parseAnchorPage(value: string | undefined): number | "latest" {
  if (value === undefined || value.length === 0 || value === "latest") {
    return "latest";
  }

  if (!/^-?\d+$/.test(value)) {
    throw new BadRequestException("Invalid anchorPage");
  }

  const page = Number(value);
  if (!Number.isSafeInteger(page)) {
    throw new BadRequestException("Invalid anchorPage");
  }

  return page;
}

function parseWindowDistance(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return STORYLINE_CHAPTER_CACHE_RADIUS;
  }

  if (!/^\d+$/.test(value)) {
    throw new BadRequestException("Invalid chapter window distance");
  }

  const distance = Number(value);
  if (
    !Number.isSafeInteger(distance) ||
    distance < 0 ||
    distance > STORYLINE_CHAPTER_CACHE_RADIUS
  ) {
    throw new BadRequestException("Invalid chapter window distance");
  }

  return distance;
}

function mapStorylineHttpError(error: unknown): Error {
  if (error instanceof StorylineBusyError) {
    return new ConflictException("Storyline is busy");
  }

  if (error instanceof StorylineNotFoundError) {
    return new NotFoundException("Storyline not found");
  }

  if (error instanceof StorylineCopyChapterOutOfRangeError) {
    return new BadRequestException("Storyline copy chapter is out of range");
  }

  return error instanceof Error ? error : new Error(String(error));
}
