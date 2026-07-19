import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { StoryController } from "./story.controller";
import { StoryService } from "./story.service";

@Module({
  imports: [LlmModule],
  controllers: [StoryController],
  providers: [StoryService],
})
export class StoryModule {}
