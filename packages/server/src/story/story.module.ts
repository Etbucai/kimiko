import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { StoryService } from "./story.service";

@Module({
  imports: [LlmModule],
  providers: [StoryService],
  exports: [StoryService],
})
export class StoryModule {}
