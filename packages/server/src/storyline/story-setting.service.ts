import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import type {
  CompleteStorySettingRequest,
  CreateStorySettingResponse,
  GenerateLlmTextRequest,
  ListStorySettingsResponse,
  StorySetting as StorySettingDto,
} from "@kimiko/schema";
import {
  CompleteStorySettingRequestSchema,
  CreateStorySettingRequestSchema,
} from "@kimiko/schema";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { storySettings } from "../database/schema";
import { StorySettingNotFoundError, StorySettingSaveFailedError } from "./story-setting.errors";

type StorySettingRow = typeof storySettings.$inferSelect;

type SchemaParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{
      success: false;
      error: {
        issues: readonly {
          path: readonly PropertyKey[];
          message: string;
        }[];
      };
    }>;

const storySettingListLimit = 100;
const storySettingPreviewMaxLength = 240;

export const STORY_SETTING_COMPLETION_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责把用户的零散创作灵感补全成可复用的故事设定。",
  "设定可以包含题材、世界观、人物、关系、冲突、氛围和关键规则。",
  "输出普通文本，不要输出 JSON、Markdown 表格或代码块。",
  "可以分段组织内容，但不要要求用户继续补充信息。",
  "不要生成故事正文，只生成设定。",
].join("\n");

@Injectable()
export class StorySettingService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listSettings(userId: string): Promise<ListStorySettingsResponse> {
    const internalUserId = parseAuthenticatedUserId(userId);
    const settings = await this.databaseService.db
      .select()
      .from(storySettings)
      .where(eq(storySettings.userId, internalUserId))
      .orderBy(desc(storySettings.createdAt), desc(storySettings.id))
      .limit(storySettingListLimit);

    return {
      settings: settings.map(mapSettingListItemDto),
    };
  }

  async getSettingForUser(input: {
    readonly userId: string;
    readonly settingId: string;
  }): Promise<StorySettingDto | null> {
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const internalSettingId = parseExternalId(input.settingId);
    if (internalSettingId === null) {
      return null;
    }

    const [setting] = await this.databaseService.db
      .select()
      .from(storySettings)
      .where(
        and(
          eq(storySettings.id, internalSettingId),
          eq(storySettings.userId, internalUserId),
        ),
      )
      .limit(1);

    return setting === undefined ? null : mapSettingDto(setting);
  }

  async getRequiredSettingForUser(input: {
    readonly userId: string;
    readonly settingId: string;
  }): Promise<StorySettingDto> {
    const setting = await this.getSettingForUser(input);
    if (setting === null) {
      throw new StorySettingNotFoundError();
    }

    return setting;
  }

  async createSetting(input: {
    readonly body: unknown;
    readonly userId: string;
  }): Promise<CreateStorySettingResponse> {
    const request = parseRequest(
      CreateStorySettingRequestSchema.safeParse(input.body),
    );
    const internalUserId = parseAuthenticatedUserId(input.userId);
    const now = new Date();

    try {
      const setting = this.databaseService.db
        .insert(storySettings)
        .values({
          userId: internalUserId,
          content: request.content.trim(),
          createdAt: now,
        })
        .returning()
        .get();

      if (setting === undefined) {
        throw new Error("Failed to insert story setting");
      }

      return {
        setting: mapSettingDto(setting),
      };
    } catch (error: unknown) {
      throw new StorySettingSaveFailedError(toErrorMessage(error));
    }
  }

  buildCompletionLlmRequest(body: unknown): GenerateLlmTextRequest {
    const request = parseRequest<CompleteStorySettingRequest>(
      CompleteStorySettingRequestSchema.safeParse(body),
    );

    return {
      systemPrompt: STORY_SETTING_COMPLETION_SYSTEM_PROMPT,
      userPrompt: [
        "用户灵感：",
        request.inspiration,
        "",
        "请基于以上灵感生成一份详细、可复用的故事设定。",
      ].join("\n"),
    };
  }
}

function mapSettingDto(setting: StorySettingRow): StorySettingDto {
  return {
    id: String(setting.id),
    content: setting.content,
    createdAt: dateToIsoString(setting.createdAt),
  };
}

function mapSettingListItemDto(
  setting: StorySettingRow,
): ListStorySettingsResponse["settings"][number] {
  return {
    id: String(setting.id),
    preview: buildSettingPreview(setting.content),
    createdAt: dateToIsoString(setting.createdAt),
  };
}

function buildSettingPreview(content: string): string {
  return truncateSnippet(
    normalizeSnippet(content),
    storySettingPreviewMaxLength,
  );
}

function parseRequest<T>(result: SchemaParseResult<T>): T {
  if (result.success) {
    return result.data;
  }

  throw new BadRequestException({
    message: "Invalid request body",
    issues: result.error.issues,
  });
}

function parseAuthenticatedUserId(userId: string): number {
  const parsedUserId = parseExternalId(userId);
  if (parsedUserId === null) {
    throw new UnauthorizedException("Invalid authenticated user");
  }

  return parsedUserId;
}

function parseExternalId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}

function dateToIsoString(value: Date): string {
  return value.toISOString();
}

function normalizeSnippet(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateSnippet(value: string, maxLength: number): string {
  if (value.length === 0) {
    throw new InternalServerErrorException("Story setting content is empty");
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
