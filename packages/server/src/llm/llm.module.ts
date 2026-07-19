import { Module } from "@nestjs/common";
import { LlmController } from "./llm.controller";
import { llmProviders } from "./llm.providers";
import { LlmService } from "./llm.service";

@Module({
  controllers: [LlmController],
  providers: [...llmProviders, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
