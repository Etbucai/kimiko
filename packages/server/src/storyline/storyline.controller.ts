import { Controller, Get, NotFoundException, UseGuards } from "@nestjs/common";
import { Param } from "@nestjs/common";
import type {
  GetRecentStorylineResponse,
  GetStorylineResponse,
  GetStorylineSummaryResponse,
  ListStorylinesResponse,
} from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { StorylineNotFoundError } from "./storyline.errors";
import { StorylineService } from "./storyline.service";

@Controller("storylines")
export class StorylineController {
  constructor(private readonly storylineService: StorylineService) {}

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

  @Get(":storylineId/summary")
  @UseGuards(JwtAuthGuard)
  async getSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storylineId") storylineId: string,
  ): Promise<GetStorylineSummaryResponse> {
    try {
      const summary = await this.storylineService.getCharacterSummaryForUser(
        user.userId,
        storylineId,
      );

      return { summary };
    } catch (error: unknown) {
      throw mapStorylineHttpError(error);
    }
  }
}

function mapStorylineHttpError(error: unknown): Error {
  if (error instanceof StorylineNotFoundError) {
    return new NotFoundException("Storyline not found");
  }

  return error instanceof Error ? error : new Error(String(error));
}
