import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LlmModule } from "../llm/llm.module";
import { StoryModule } from "../story/story.module";
import { StorylineController } from "./storyline.controller";
import { StorylineContextService } from "./storyline-context.service";
import { StorySettingController } from "./story-setting.controller";
import { StorySettingService } from "./story-setting.service";
import { StoryGenerationTaskRegistry } from "./story-generation-task.registry";
import { StoryGenerationTaskService } from "./story-generation-task.service";
import { StorylineGenerationService } from "./storyline-generation.service";
import { StorylineLockService } from "./storyline-lock.service";
import { StorylineService } from "./storyline.service";

@Module({
  imports: [DatabaseModule, LlmModule, StoryModule],
  controllers: [StorylineController, StorySettingController],
  providers: [
    StoryGenerationTaskRegistry,
    StoryGenerationTaskService,
    StorySettingService,
    StorylineGenerationService,
    StorylineContextService,
    StorylineLockService,
    StorylineService,
  ],
  exports: [
    StoryGenerationTaskService,
    StorySettingService,
    StorylineGenerationService,
    StorylineService,
  ],
})
export class StorylineModule {}
