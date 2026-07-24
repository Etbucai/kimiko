import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import type { GenerateLlmTextResponse } from "@kimiko/schema";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { LlmService } from "./llm.service";

@Controller("llm")
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post("generate")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  generate(@Body() body: unknown): Promise<GenerateLlmTextResponse> {
    return this.llmService.generateText(body);
  }
}
