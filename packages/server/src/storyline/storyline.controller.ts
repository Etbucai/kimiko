import { Controller, Get, UseGuards } from "@nestjs/common";
import type { GetRecentStorylineResponse } from "@kimiko/schema";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { StorylineService } from "./storyline.service";

@Controller("storylines")
export class StorylineController {
  constructor(private readonly storylineService: StorylineService) {}

  @Get("recent")
  @UseGuards(JwtAuthGuard)
  getRecent(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GetRecentStorylineResponse> {
    return this.storylineService.getRecentStoryline(user.userId);
  }
}
