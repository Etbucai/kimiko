# 从设定开始创建故事服务端技术方案

## 背景

本文档对应 PRD：[setting-start-prd.md](./setting-start-prd.md) 和前端技术方案：[setting-start-prd-fe.md](./setting-start-prd-fe.md)。

012 的产品目标是：新增一条「从设定开始」的创建故事链路。服务端需要支持三类能力：

- 设定管理：保存、查询当前用户的纯文本设定。
- 设定补全：根据用户灵感流式生成一份详细设定，但补全过程不落库。
- 从设定创建故事：用户提交设定 ID 和开场后，服务端读取设定内容，生成新故事，并沿用现有故事线保存、context 抽取、实时事件和后台任务机制。

前端方案已经给出 IDL Schema。本服务端方案采纳该 IDL，不需要额外输出 `setting-start-prd-fe-idl-change.md`。

## 已确认决策

- 新增独立服务端技术文档：`docs/012/setting-start-prd-server.md`。
- 采纳前端技术方案中的 IDL Schema，不做字段级变更。
- 设定以纯文本存储，不做结构化字段。
- 设定只属于创建它的用户。
- 设定列表按创建时间倒序返回。
- 设定不支持编辑和删除。
- 设定补全使用独立 HTTP NDJSON 流式接口，不复用故事 WebSocket。
- 设定补全过程不落库。
- 保存设定只保存前端提交的补全结果文本，不保存原始灵感。
- 从设定创建故事通过 WebSocket `story.continue` 新增 `mode: "createFromSetting"`。
- `createFromSetting` 不让前端提交设定内容，只提交 `settingId + opening`。
- 服务端在生成前读取并校验设定归属。
- `createFromSetting` 使用与普通 create 相同的用户级创建锁。
- `createFromSetting` 和普通 create 一样，不支持退出后按 REST 找回或取消运行中任务。
- 新故事保存后仍返回 `CompletedStorylineSnapshot`，不扩展故事快照结构。
- 本期不把 `settingId` 持久化到故事线或 segment；故事线通过初始 segment 文本自包含设定与开场。

## 非目标

- 不实现设定编辑接口。
- 不实现设定删除接口。
- 不实现设定搜索、筛选、分类、模板或分享。
- 不保存设定补全草稿。
- 不保存用户开场草稿。
- 不新增持久化任务队列。
- 不改变 append / rewrite / dialogue 的既有行为。
- 不把设定作为正式故事上下文的独立数据源长期关联。
- 不为已创建故事提供“查看来源设定”能力。

## 前端 IDL 读取结论

前端方案中的 IDL 可以直接作为服务端共享契约：

- `StorySettingId`
- `StorySetting`
- `StorySettingListItem`
- `ListStorySettingsResponse`
- `GetStorySettingResponse`
- `CompleteStorySettingRequest`
- `CreateStorySettingRequest`
- `CreateStorySettingResponse`
- `StoryContinueCreateFromSettingPayload`
- `StoryGenerationMode` 增加 `createFromSetting`
- `StoryRealtimeErrorCode` 增加设定相关错误码

无需调整点：

- 不需要给 `StorySetting` 增加 `updatedAt`，因为本期没有编辑能力。
- 不需要给 `StorySetting` 增加 `title`，列表展示使用服务端派生的 `preview`。
- 不需要让 `createFromSetting` payload 携带 `setting.content`，服务端读取数据库中的设定内容即可。
- 不需要扩展 `StorylineSnapshot`，从设定创建后的第一页仍通过 `initial` segment 表达。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 SQLite + Drizzle。
- 共享契约集中在 `@kimiko/schema`，使用 Zod 作为单一事实源。
- 当前故事线主模块是 `StorylineModule`。
- 当前实时故事生成链路为：

```text
RealtimeGateway
  -> StoryGenerationTaskService
  -> StorylineGenerationService
  -> StoryService
  -> StorylineContextService
  -> StorylineService
```

- 后台任务状态已经由 `StoryGenerationTaskService` / `StoryGenerationTaskRegistry` 管理。
- `create` 任务使用用户级创建锁，不通过 REST status / cancel 暴露。
- `append / rewrite / dialogue` 使用故事线级锁。
- context 抽取失败时，正文和 context 不进入正式故事线。
- `storyline_segment` 已包含 `target_length`，但本期 create-from-setting 不使用该字段。
- 当前 `StorylineSnapshot` 只包含 segments、latestGeneration 和 updatedAt。

## 设计总览

012 服务端改动分为五层：

```text
共享契约
  - 新增设定 DTO / 请求响应 schema
  - StoryContinuePayload 增加 createFromSetting
  - StoryGenerationMode 增加 createFromSetting
  - StoryRealtimeErrorCode 增加设定错误码

数据库
  - 新增 story_setting 表

设定 API
  - GET /story-settings
  - GET /story-settings/:settingId
  - POST /story-settings
  - POST /story-settings/complete/stream

故事生成
  - RealtimeGateway 支持 createFromSetting payload
  - TaskService 把 createFromSetting 视为 create 类任务
  - StorylineGenerationService 新增 streamCreateFromSettingStoryline
  - StoryService 新增从设定创建故事 writer prompt

保存与 context
  - 使用现有 saveCreatedStorylineWithContext
  - initial segment 保存设定与开场的组合文本
  - generated segment 保存模型生成正文
  - context extractor 仍按 create 操作生成初始 context
```

## 共享契约

在 `packages/schema/src/index.ts` 中新增前端方案定义的 schema。

### 设定模型

```ts
export const StorySettingIdSchema = z.string().trim().min(1);
export type StorySettingId = z.infer<typeof StorySettingIdSchema>;

export const StorySettingContentSchema = z.string().trim().min(1).max(20_000);
export type StorySettingContent = z.infer<typeof StorySettingContentSchema>;

export const StorySettingSchema = z
  .object({
    id: StorySettingIdSchema,
    content: StorySettingContentSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const StorySettingListItemSchema = z
  .object({
    id: StorySettingIdSchema,
    preview: z.string().trim().min(1).max(240),
    createdAt: z.string().datetime(),
  })
  .strict();
```

### 设定 API schema

```ts
export const ListStorySettingsResponseSchema = z
  .object({
    settings: z.array(StorySettingListItemSchema).max(100),
  })
  .strict();

export const GetStorySettingResponseSchema = z
  .object({
    setting: StorySettingSchema,
  })
  .strict();

export const CompleteStorySettingRequestSchema = z
  .object({
    inspiration: z.string().trim().min(1).max(8_000),
  })
  .strict();

export const CreateStorySettingRequestSchema = z
  .object({
    content: StorySettingContentSchema,
  })
  .strict();

export const CreateStorySettingResponseSchema = z
  .object({
    setting: StorySettingSchema,
  })
  .strict();
```

### 从设定创建故事 payload

```ts
export const StoryContinueCreateFromSettingPayloadSchema = z
  .object({
    mode: z.literal("createFromSetting"),
    settingId: StorySettingIdSchema,
    opening: z.string().trim().min(1).max(8_000),
  })
  .strict();
```

`StoryContinuePayloadSchema` 增加该分支：

```ts
export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueCreateFromSettingPayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
  StoryContinueDialoguePayloadSchema,
]);
```

`StoryGenerationModeSchema` 增加 `createFromSetting`。

### 错误码

`StoryRealtimeErrorCodeSchema` 增加：

```ts
"STORY_SETTING_NOT_FOUND",
"STORY_SETTING_ACCESS_DENIED",
```

实际实现建议：

- 查询不到设定，或设定不属于当前用户，都映射为 `STORY_SETTING_NOT_FOUND`。
- `STORY_SETTING_ACCESS_DENIED` 先保留在契约中，不作为本期常规返回，避免泄露设定是否存在。

## 数据库设计

### `story_setting` 表

在 `packages/server/src/database/schema/storylines.schema.ts` 中新增：

```ts
export const storySettings = sqliteTable(
  "story_setting",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("story_setting_user_id_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);
```

导出类型：

```ts
export type StorySetting = InferSelectModel<typeof storySettings>;
export type NewStorySetting = InferInsertModel<typeof storySettings>;
```

说明：

- 不加 `updated_at`，因为本期不支持编辑。
- 不单独存 `preview`，列表 DTO 由服务端从 `content` 派生。
- 不加唯一约束，允许用户保存多份内容相同的设定。
- `user_id` 级联删除，用户删除后设定自动清理。

### 迁移

新增 Drizzle migration，例如：

```sql
CREATE TABLE `story_setting` (
  `id` integer PRIMARY KEY NOT NULL,
  `user_id` integer NOT NULL,
  `content` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `story_setting_user_id_created_at_idx`
ON `story_setting` (`user_id`, `created_at`);
```

推荐使用：

```bash
pnpm --filter @kimiko/server db:generate
```

再检查生成的 migration 是否只包含 `story_setting` 相关变更。

## 模块与文件设计

为了避免 `StorylineModule` 与新模块之间出现循环依赖，本期建议把设定能力纳入现有 `StorylineModule`，但拆成独立文件。

新增文件：

- `packages/server/src/storyline/story-setting.controller.ts`
- `packages/server/src/storyline/story-setting.service.ts`
- `packages/server/src/storyline/story-setting.errors.ts`

调整：

- `packages/server/src/storyline/storyline.module.ts`
  - providers 增加 `StorySettingService`
  - controllers 增加 `StorySettingController`
  - exports 增加 `StorySettingService`
- `packages/server/src/storyline/storyline-generation.service.ts`
  - 注入 `StorySettingService`
  - 增加 `createFromSetting` 分支
- `packages/server/src/story/story.service.ts`
  - 增加从设定创建故事的 writer 方法
- `packages/server/src/realtime/realtime.gateway.ts`
  - helper 识别 `createFromSetting` 为无 storylineId 的 create 类 payload
- `packages/server/src/realtime/realtime-error.utils.ts`
  - 增加设定错误码文案和错误映射
- `packages/server/src/storyline/story-generation-task.service.ts`
  - create 类任务判断包含 `createFromSetting`
- `packages/server/src/storyline/story-generation-task.registry.ts`
  - create key 生成包含 `createFromSetting`
- `packages/server/src/database/schema/index.ts`
  - 自动随 schema export 覆盖

## StorySettingService 设计

职责：

- 校验并解析用户 ID / 设定 ID。
- 保存设定。
- 查询当前用户设定列表。
- 查询当前用户设定详情。
- 构建设定补全 LLM request。
- 提供 `getRequiredSettingForUser` 给生成链路使用。

建议接口：

```ts
@Injectable()
export class StorySettingService {
  listSettings(userId: string): Promise<ListStorySettingsResponse>;

  getSettingForUser(input: {
    readonly userId: string;
    readonly settingId: string;
  }): Promise<StorySettingDto | null>;

  getRequiredSettingForUser(input: {
    readonly userId: string;
    readonly settingId: string;
  }): Promise<StorySettingDto>;

  createSetting(input: {
    readonly userId: string;
    readonly content: string;
  }): Promise<CreateStorySettingResponse>;

  buildCompletionLlmRequest(
    request: CompleteStorySettingRequest,
  ): GenerateLlmTextRequest;
}
```

列表限制：

```ts
const storySettingListLimit = 100;
const storySettingPreviewMaxLength = 240;
```

列表排序：

```ts
orderBy(desc(storySettings.createdAt), desc(storySettings.id));
```

### Preview 派生

推荐 helper：

```ts
function buildSettingPreview(content: string): string {
  return truncateSnippet(normalizeSnippet(content), 240);
}
```

规则：

- 折叠连续空白。
- 去掉首尾空白。
- 为空时不应发生，因为 schema 和保存层都要求非空。
- 超过 240 字符时截断并加省略号。

### 归属校验

`getSettingForUser` 使用 `id + userId` 同时过滤：

```ts
where(
  and(
    eq(storySettings.id, internalSettingId),
    eq(storySettings.userId, internalUserId),
  ),
);
```

这样跨用户访问和不存在返回同一种 `null`，避免泄露设定存在性。

## StorySettingController 设计

Controller：

```ts
@Controller("story-settings")
export class StorySettingController {}
```

所有接口使用 `JwtAuthGuard`。

### 列表

```http
GET /story-settings
Authorization: Bearer <token>
```

返回：

```ts
ListStorySettingsResponse;
```

行为：

- 返回当前用户最多 100 条设定。
- 按创建时间倒序。
- 不返回完整 `content`，只返回 `preview`。

### 详情

```http
GET /story-settings/:settingId
Authorization: Bearer <token>
```

返回：

```ts
GetStorySettingResponse;
```

行为：

- 设定不存在或不属于当前用户，返回 404。
- 成功返回完整 `content`。

### 保存

```http
POST /story-settings
Authorization: Bearer <token>
Content-Type: application/json
```

请求：

```ts
CreateStorySettingRequest;
```

返回：

```ts
CreateStorySettingResponse;
```

行为：

- 使用 `CreateStorySettingRequestSchema` 强校验。
- 保存 `content.trim()`。
- 成功返回完整设定。
- 保存失败返回 500。

### 补全流式接口

```http
POST /story-settings/complete/stream
Authorization: Bearer <token>
Accept: application/x-ndjson
Content-Type: application/json
```

请求：

```ts
CompleteStorySettingRequest;
```

响应事件复用 `GenerateLlmTextStreamEvent`：

```text
started
chunk
completed
error
```

实现方式：

- 与 `LlmController.generateStream` 一样设置：
  - `Cache-Control: no-cache, no-transform`
  - `Content-Type: application/x-ndjson; charset=utf-8`
  - `X-Accel-Buffering: no`
- `request.close` 时 abort。
- controller 写 `started` 事件。
- 遍历 `llmService.streamTextFromParsedRequest(...)` 输出 chunk / completed。
- 捕获错误时输出 `error` 事件。
- 不调用任何保存逻辑。

可以把 `LlmController` 中的 NDJSON 写入 helper 抽出复用，也可以在 `StorySettingController` 内保持局部私有函数，优先避免大范围重构。

## 设定补全 Prompt

在 `StorySettingService` 或 `story.service.ts` 附近定义专用 prompt。

建议：

```ts
export const STORY_SETTING_COMPLETION_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责把用户的零散创作灵感补全成可复用的故事设定。",
  "设定可以包含题材、世界观、人物、关系、冲突、氛围和关键规则。",
  "输出普通文本，不要输出 JSON、Markdown 表格或代码块。",
  "可以分段组织内容，但不要要求用户继续补充信息。",
  "不要生成故事正文，只生成设定。",
].join("\n");
```

user prompt：

```text
用户灵感：
{inspiration}

请基于以上灵感生成一份详细、可复用的故事设定。
```

说明：

- 前端不传 system prompt。
- 服务端统一封装补全 prompt，保证产品行为稳定。
- 设定补全输出不做结构化校验，只要求最终文本非空由流式 LLM 层保证。

## 从设定创建故事生成链路

### RealtimeGateway

现有 helper 需要识别 create 类 payload：

```ts
function isCreateLikePayload(payload: StoryContinuePayload): boolean {
  return payload.mode === "create" || payload.mode === "createFromSetting";
}
```

调整：

- `getStorylineIdFromPayload` 对 `createFromSetting` 返回 `null`。
- `getTargetLengthFromPayload` 只对 `append` 返回。
- 日志增加 `settingId`：

```ts
settingId: payload.mode === "createFromSetting" ? payload.settingId : undefined;
```

### TaskService / Registry

`createFromSetting` 是 create 类任务：

- 使用 task key：`create:${userId}:${requestId}`。
- 不通过 REST status/cancel 暴露。
- WebSocket 断开后继续执行。
- 任务终态后像普通 create 一样从 registry 删除。

需要调整的位置：

- `StoryGenerationModeSchema` 支持 `createFromSetting`。
- `StoryGenerationTaskService.start` 中判断 storyline active task 时，只对 `append / rewrite / dialogue` 读取 `storylineId`。
- `StoryGenerationTaskRegistry.createTask` 中生成 key 时，把 `createFromSetting` 和 `create` 放在同一类。

### StorylineGenerationService

`streamContinueStoryline` 新增分支：

```ts
if (input.payload.mode === "createFromSetting") {
  yield * this.streamCreateFromSettingStoryline(input, options);
  return;
}
```

新增方法职责：

1. 读取并校验设定归属。
2. 获取用户级 create lock。
3. 构造 writer context。
4. 流式生成正文。
5. 生成完成后触发 context extractor。
6. 在事务内保存 storyline、initial segment、generated segment、context。
7. 返回 completed event。

伪代码：

```ts
private async *streamCreateFromSettingStoryline(
  input: ContinueStorylineInput,
  options: StorylineGenerationOptions,
): AsyncIterable<StorylineStreamEvent> {
  assert input.payload.mode === "createFromSetting";

  const setting = await this.storySettingService.getRequiredSettingForUser({
    userId: input.userId,
    settingId: input.payload.settingId,
  });

  const releaseLock = this.storylineLockService.acquireCreateLock(input.userId);
  try {
    const initialStoryText = buildCreateFromSettingInitialText({
      settingContent: setting.content,
      opening: input.payload.opening,
    });

    for await (const event of this.storyService.streamCreateStoryFromSetting(
      {
        settingContent: setting.content,
        opening: input.payload.opening,
      },
      options,
    )) {
      // chunk 直接 yield
      // completed 后生成 context patch 并保存
    }
  } finally {
    releaseLock();
  }
}
```

日志字段：

- `mode: "createFromSetting"`
- `settingId`
- `requestId`
- `requestUserId`
- `generatedTextChars`
- `chunkCount`
- `chunkChars`
- `generatedSegmentId`

### StoryService

新增类型：

```ts
export interface StoryCreateFromSettingLlmContext {
  readonly settingContent: string;
  readonly opening: string;
}
```

新增方法：

```ts
async *streamCreateStoryFromSetting(
  context: StoryCreateFromSettingLlmContext,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent> {
  yield* this.streamStoryLlmRequest(
    buildCreateFromSettingLlmRequest(context),
    options,
  );
}
```

推荐专用 system prompt：

```ts
export const STORY_CREATE_FROM_SETTING_SYSTEM_PROMPT = [
  "你是 StoryAgent，负责根据用户提供的故事设定和开场方向生成新故事开端。",
  "设定是创作背景，不是需要逐字复述的正文。",
  "开场方向描述本次故事应该从哪里开始。",
  "你必须只输出新生成的故事正文。",
  "不要输出设定整理、标题、解释、列表、调试信息或“以下是正文”等前缀。",
  "输出语言必须跟随用户开场和设定的主要语言。",
].join("\n");
```

user prompt：

```text
故事设定：
{settingContent}

开场方向：
{opening}

请基于设定和开场方向，生成新故事的开端正文。
```

说明：

- 不建议复用普通 `buildStorySystemPrompt`，因为普通 create prompt 会把输入视为“已有故事正文”，而设定不是正文。
- 输出仍走 `streamStoryLlmRequest`，复用空输出、usage、model、elapsedMs 等现有校验。

## 保存与 context 设计

### 初始 segment 文本

保存 initial segment 时，需要把设定和开场组合成可读文本，保证故事线脱离设定表后仍可完整阅读。

推荐 helper：

```ts
export function buildCreateFromSettingInitialText(input: {
  readonly settingContent: string;
  readonly opening: string;
}): string {
  return [
    "【设定】",
    input.settingContent.trim(),
    "",
    "【开场】",
    input.opening.trim(),
  ].join("\n");
}
```

注意：

- 前端技术方案也建议使用同样格式构造本地 preview。
- 服务端保存时必须重新构造，不信任前端 preview。

### 保存方法

本期不需要新增数据库保存方法，可以复用：

```ts
saveCreatedStorylineWithContext({
  userId,
  initialStoryText,
  instruction: opening,
  generatedText,
  model,
  elapsedMs,
  usage,
  contextPatch,
});
```

保存语义：

- initial segment：`buildCreateFromSettingInitialText(...)`
- generated segment：writer 生成正文
- generated segment `instruction`：用户 opening
- generated segment `generationMode`：继续保存为 `append`
- `targetLength`：`null`
- `previousContextJson`：空 context
- storyline 不保存 `settingId`

### Context extractor

`createFromSetting` 保存前仍使用 create 操作生成 context patch：

```ts
operation: "create";
previousContext: null;
sourceRefMappings: [
  {
    ref: "initial",
    label: "设定与开场",
    text: initialStoryText,
  },
  {
    ref: "current",
    label: "本轮生成正文",
    text: generatedText,
  },
];
initialStoryText;
recentHistoryRounds: [];
currentInstruction: opening;
generatedText;
```

原因：

- 新故事保存结构仍是 initial + generated。
- context extractor 只关心新故事的初始材料和生成正文，不需要知道它来自普通 create 还是 setting create。

### 故事列表标题

当前列表标题来自 initial segment 的第一行。如果 initial segment 第一行固定是 `【设定】`，故事列表标题会退化。

需要调整 `mapListItemDto` 的标题提取 helper：

- 如果 initial text 包含 `【开场】` 标记，优先使用 `【开场】` 后的第一条非空行。
- 否则沿用当前第一条非空行。
- 仍使用 80 字截断。

这样不会扩展 DTO，也能保持从设定创建的故事列表可读。

## 错误处理

新增错误类：

```ts
export class StorySettingNotFoundError extends Error {}
export class StorySettingSaveFailedError extends Error {}
```

REST 映射：

- `StorySettingNotFoundError` -> 404。
- schema 校验失败 -> 400。
- 保存失败 -> 500。
- 补全流式错误 -> NDJSON `error` 事件。

Realtime 映射：

`realtime-error.utils.ts` 增加：

```ts
STORY_SETTING_NOT_FOUND: "设定不存在",
STORY_SETTING_ACCESS_DENIED: "设定不可用",
```

`mapRealtimeStreamErrorCode` 增加：

```ts
if (error instanceof StorySettingNotFoundError) {
  return "STORY_SETTING_NOT_FOUND";
}
```

跨用户访问设定时，`StorySettingService` 直接抛 `StorySettingNotFoundError`。

## 日志

### 设定 API 日志

建议在 `StorySettingService` 或 controller 中记录结构化日志：

- `story_setting_list_completed`
- `story_setting_get_completed`
- `story_setting_create_completed`
- `story_setting_completion_started`
- `story_setting_completion_completed`
- `story_setting_completion_failed`

字段：

- `userId`
- `settingId`
- `contentChars`
- `inspirationChars`
- `elapsedMs`
- `error`

### createFromSetting 生成日志

复用 `StorylineGenerationService.logGenerationPhase`，增加：

- `settingId`
- `mode: "createFromSetting"`
- `phase`
- `generatedTextChars`
- `chunkCount`
- `chunkChars`
- `generatedSegmentId`

注意不要记录完整设定内容和完整开场，避免日志过大。

## 安全与权限

- 所有 `story-settings` 接口都必须使用 `JwtAuthGuard`。
- 所有设定查询都按 `userId + settingId` 过滤。
- 不提供跨用户查询。
- 不在错误信息中区分“不存在”和“无权限”。
- 不把完整设定写入普通结构化日志。
- LLM 调用文件日志会记录 prompt，符合现有 LLM 调试日志机制，本期不单独改造。

## 测试计划

### Schema

覆盖：

- `StorySettingContentSchema` trim / min / max。
- `CompleteStorySettingRequestSchema` 非空和长度。
- `CreateStorySettingRequestSchema` 非空和长度。
- `StoryContinuePayloadSchema` 能 parse `createFromSetting`。
- `StoryGenerationModeSchema` 包含 `createFromSetting`。

### StorySettingService 单测

覆盖：

- 创建设定保存 trimmed content。
- 空 content 被 schema 层拒绝。
- 列表只返回当前用户设定。
- 列表按 `createdAt desc, id desc`。
- 列表返回 preview，不返回 content。
- 详情只允许当前用户访问。
- 跨用户访问返回 null / not found。
- `buildCompletionLlmRequest` 使用固定 system prompt，用户灵感只进入 user prompt。

### StorySettingController / e2e

覆盖：

- 未登录访问返回 401。
- `GET /story-settings` 返回当前用户列表。
- `POST /story-settings` 成功保存并返回 setting。
- `GET /story-settings/:id` 成功返回 content。
- 访问不存在设定返回 404。
- `POST /story-settings/complete/stream` 返回 NDJSON started / chunk / completed。
- 补全失败返回 NDJSON error。

### StorylineGenerationService 单测

覆盖：

- `createFromSetting` 会读取当前用户设定。
- 设定不存在时抛 `StorySettingNotFoundError`。
- 使用用户级 create lock。
- 调用 `storyService.streamCreateStoryFromSetting`。
- context extractor 使用 initial + current source refs。
- 保存时 initial text 包含设定和开场。
- 保存时 instruction 使用 opening。
- 成功 yield chunk / contextStarted / completed。

### Realtime e2e

覆盖：

- WebSocket `story.continue` 支持 `mode: "createFromSetting"`。
- 非法 settingId 返回 `STORY_SETTING_NOT_FOUND`。
- 成功时返回 `story.started`、`story.chunk`、`story.context.started`、`story.completed`。
- completed 返回的新故事 snapshot 第一页包含设定和开场。
- createFromSetting 不影响 append / rewrite / dialogue。

## 验证命令

推荐执行：

```bash
pnpm --filter @kimiko/server typecheck
pnpm --filter @kimiko/server lint
pnpm --filter @kimiko/server test
pnpm --filter @kimiko/server build
```

涉及共享契约后，也需要执行：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web build
```

数据库变更后执行：

```bash
pnpm --filter @kimiko/server db:generate
pnpm --filter @kimiko/server db:migrate
```

## 风险与取舍

### 不持久化 `settingId` 关联

本期生成后的故事线不再依赖设定表。好处是设定未来即使被删除或编辑，也不影响已创建故事；代价是后续无法直接统计“某个故事来自哪份设定”。如果未来需要来源追踪，再新增 nullable source 字段更合适。

### initial segment 同时承载设定和开场

这是为了不扩展 `StorylineSnapshot`。代价是 initial segment 语义从“初始正文”扩展为“初始创作材料”。本期通过明确格式和列表标题提取规则降低影响。

### 补全流式接口与通用 LLM 流式接口重复

`story-settings/complete/stream` 和 `/llm/generate/stream` 协议相似，但保留独立业务接口可以让服务端掌控 prompt，并避免前端获得任意 prompt 拼接能力。

### createFromSetting 是 create 类任务

它不支持退出后找回运行状态，和普通 create 保持一致。这样实现最小，但用户离开页面后只能通过故事列表找到完成后的新故事，不能看到运行中的进度。
