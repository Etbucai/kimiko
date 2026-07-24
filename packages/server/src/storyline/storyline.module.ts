import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LlmModule } from "../llm/llm.module";
import { StoryModule } from "../story/story.module";
import { StorylineController } from "./storyline.controller";
import { StorylineContextService } from "./storyline-context.service";
import { StorylineGenerationService } from "./storyline-generation.service";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

@Module({
  imports: [DatabaseModule, LlmModule, StoryModule],
  controllers: [StorylineController],
  providers: [
    StorylineGenerationService,
    StorylineContextService,
    StorylineLockService,
    StorylineService,
  ],
  exports: [StorylineGenerationService, StorylineService],
})
export class StorylineModule {}
