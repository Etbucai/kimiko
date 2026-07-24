import {
  Controller,
  Get,
  NotFoundException,
  Post,
  UseGuards,
  Param,
} from "@nestjs/common";
import type {
  CancelStoryGenerationResponse,
  GetRecentStorylineResponse,
  GetStorylineContextResponse,
  GetStorylineResponse,
  ListStorylinesResponse,
  StoryGenerationStatusResponse,
} from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { StorylineNotFoundError } from "./storyline.errors";
import { StoryGenerationTaskService } from "./story-generation-task.service";
import { StorylineService } from "./storyline.service";

@Controller("storylines")
export class StorylineController {
  constructor(
    private readonly storylineService: StorylineService,
    private readonly taskService: StoryGenerationTaskService,
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
  ): Promise<GetRecentStorylineResponse> {
    return this.storylineService.getRecentStoryline(user.userId);
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
      const context = await this.storylineService.getStoryContextForUser(
        user.userId,
        storylineId,
      );

      return { context };
    } catch (error: unknown) {
      throw mapStorylineHttpError(error);
    }
  }

  @Get(":storylineId")
  @UseGuards(JwtAuthGuard)
  async getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<GetStorylineResponse> {
    const storyline = await this.storylineService.getStorylineSnapshotForUser(
      user.userId,
      storylineId,
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

function mapStorylineHttpError(error: unknown): Error {
  if (error instanceof StorylineNotFoundError) {
    return new NotFoundException("Storyline not found");
  }

  return error instanceof Error ? error : new Error(String(error));
}
