import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import type { ContinueStoryResponse } from "@kimiko/schema";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { StoryService } from "./story.service";

@Controller("story")
export class StoryController {
  constructor(private readonly storyService: StoryService) {}

  @Post("continue")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  continue(@Body() body: unknown): Promise<ContinueStoryResponse> {
    return this.storyService.continueStory(body);
  }
}
