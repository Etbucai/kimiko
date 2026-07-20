import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { StoryModule } from "../story/story.module";
import { StorylineController } from "./storyline.controller";
import { StorylineGenerationService } from "./storyline-generation.service";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

@Module({
  imports: [DatabaseModule, StoryModule],
  controllers: [StorylineController],
  providers: [
    StorylineGenerationService,
    StorylineLockService,
    StorylineService,
  ],
  exports: [StorylineGenerationService, StorylineService],
})
export class StorylineModule {}
