# 引入历史消息记录服务端技术方案

## 背景

本文档对应 PRD：[history.md](./history.md) 和前端技术方案：[history-fe.md](./history-fe.md)，并基于上一期流式输出服务端技术方案：[../003/streaming-server.md](../003/streaming-server.md)。

本期目标是在服务端引入 `Storyline` 持久化能力：保存同一故事线的初始正文、每轮 Agent 续写正文、用户续写指令和生成元数据；恢复当前用户最近故事线；在 WebSocket 续写时读取最近 N 轮历史构造 StoryAgent prompt；生成成功且保存成功后再向前端发送 completed 快照。

## IDL 结论

已读取前端技术方案 [history-fe.md](./history-fe.md) 中的 IDL Schema。本服务端技术方案沿用前端技术方案中的 IDL，不需要修改，因此不额外输出 `history-fe-idl-change.md`。

服务端需要在 `packages/schema/src/index.ts` 中实现并使用前端技术方案定义的契约：

- `StorylineIdSchema`
- `StorylineSegmentIdSchema`
- `StorylineSegmentSchema`
- `StorylineGenerationMetadataSchema`
- `StorylineSnapshotSchema`
- `CompletedStorylineSnapshotSchema`
- `GetRecentStorylineResponseSchema`
- `StoryContinuePayloadSchema`
- 更新后的 `StoryContinueClientMessageSchema`
- 更新后的 `StoryCompletedServerEventSchema`
- 扩展后的 `StoryRealtimeErrorCodeSchema`

关键接口与事件：

- `GET /storylines/recent`
- WebSocket `story.continue`，payload 使用 `mode: "create" | "append"`。
- WebSocket `story.completed` 返回保存成功后的 `CompletedStorylineSnapshot`。

## 已确认决策

- “故事线”在代码和 IDL 中命名为 `Storyline`。
- 新增 Storyline 持久化能力，使用 SQLite + Drizzle。
- 数据库使用 `storyline` + `storyline_segment` 两张表。
- 对外 `storylineId`、`segmentId` 使用字符串化自增 ID。
- 当前用户最近故事线按 `updatedAt` 倒序恢复。
- 无故事线时，`GET /storylines/recent` 返回 `200` 和 `{ storyline: null }`。
- 历史窗口配置名为 `STORY_HISTORY_ROUND_LIMIT`，默认 `20`。
- `STORY_HISTORY_ROUND_LIMIT` 必须为正整数，非法值启动失败。
- 历史窗口只影响 LLM 上下文，不裁剪数据库和恢复快照。
- Prompt 组织为窗口内正文片段 + 指令轨迹。
- 当故事线总轮数未超过窗口时，LLM 上下文包含 initial 正文。
- 当故事线总轮数超过窗口时，LLM 上下文只包含最近 N 轮 generated 正文和对应 instruction，不强制保留 initial 正文。
- 如果窗口内 prompt 仍然过长，本期不做额外裁剪；provider 拒绝时按生成失败处理。
- 同一故事线并发 append 使用进程内锁拒绝。
- 同一用户并发 create 使用进程内锁拒绝。
- 锁在 completed、error、cancel、断连路径的 finally 中释放。
- LLM completed 后，服务端在 SQLite 事务中保存 segment、metadata、updatedAt。
- 只有保存成功后才发送 `story.completed`。
- 保存失败发送 `STORYLINE_SAVE_FAILED`，不发送 completed。
- 004 不兼容旧的 `ContinueStoryRequest` WebSocket payload。
- 004 不兼容旧的 `continuedStory` completed 事件。
- 当前旧流程没有落库数据，本期不做历史数据迁移。
- 本期不新增服务端第三方依赖。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 Drizzle ORM + SQLite。
- 启动时 `DatabaseModule` 会执行 Drizzle migration。
- WebSocket 使用原生 `ws`，通过 Nest `@WebSocketGateway({ path: "/realtime" })` 暴露。
- WebSocket 鉴权使用查询参数 `accessToken`。
- HTTP 鉴权使用 `JwtAuthGuard`。
- 登录用户在 HTTP 中通过 `CurrentUser` 获取。
- WebSocket 中 `RealtimeGateway` 已能通过 `verifyAccessToken` 得到 `sub` 和 `uniqueName`。
- 当前 `LlmService.streamTextFromParsedRequest` 是内部入口，不重新执行公开 `GenerateLlmTextRequestSchema` 的 20000 字符限制。
- 当前 `StoryService` 已封装 StoryAgent system prompt 和流式 LLM 调用。

## 新增和调整文件

新增文件：

- `packages/server/src/database/schema/storylines.schema.ts`
  - 定义 `storyline` 和 `storyline_segment` 表。
- `packages/server/src/storyline/storyline.module.ts`
  - 注册 Storyline 相关 controller/service/lock。
- `packages/server/src/storyline/storyline.controller.ts`
  - 暴露 `GET /storylines/recent`。
- `packages/server/src/storyline/storyline.service.ts`
  - 负责 Storyline 查询、保存、快照映射、prompt 上下文构造。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - 负责 WebSocket create/append 生成编排。
- `packages/server/src/storyline/storyline-lock.service.ts`
  - 负责进程内 create/append 活跃任务锁。
- `packages/server/src/storyline/storyline.types.ts`
  - 定义服务端内部 Storyline 类型。
- `packages/server/src/storyline/storyline.service.spec.ts`
  - 覆盖查询、保存、快照、历史窗口和 prompt 上下文。
- `packages/server/src/storyline/storyline-generation.service.spec.ts`
  - 覆盖 create/append 编排、锁、保存失败和错误映射。
- `packages/server/test/storyline.e2e-spec.ts`
  - 覆盖恢复最近故事线 HTTP 接口。
- `packages/server/test/storyline-realtime.e2e-spec.ts`
  - 覆盖 Storyline WebSocket create/append/cancel/error 链路。

调整文件：

- `packages/schema/src/index.ts`
  - 增加 Storyline IDL。
  - 更新 `story.continue` payload schema。
  - 更新 `story.completed` event schema。
  - 扩展 realtime error code。
- `packages/server/src/database/schema/index.ts`
  - 导出 `storylines.schema.ts`。
- `packages/server/src/env.ts`
  - 增加 `story.historyRoundLimit` 或等价 getter。
  - 解析 `STORY_HISTORY_ROUND_LIMIT`。
- `packages/server/src/app.module.ts`
  - 导入 `StorylineModule`。
- `packages/server/src/realtime/realtime.module.ts`
  - 引入 `StorylineModule`。
- `packages/server/src/realtime/realtime.gateway.ts`
  - 从旧 `StoryService.streamContinueStory` 改为调用 `StorylineGenerationService.streamContinueStoryline`。
  - completed 事件返回 `storyline` 快照和 `generatedSegmentId`。
  - 扩展错误码映射。
- `packages/server/src/realtime/realtime.types.ts`
  - 扩展 `RealtimeErrorCode`。
  - 活跃任务记录可以保留 `requestId` 和 `AbortController`，Storyline 锁由 `StorylineLockService` 管理。
- `packages/server/src/story/story.service.ts`
  - 保留 StoryAgent system prompt。
  - 将 prompt 构造能力调整为支持 Storyline 历史上下文。
- `packages/server/.env.example`
  - 增加 `STORY_HISTORY_ROUND_LIMIT=20`。
- `packages/server/drizzle/*`
  - 通过 `pnpm --filter @kimiko/server db:generate` 生成新迁移。

可删除或废弃：

- 不再支持旧的 `ContinueStoryRequest` 作为 WebSocket `story.continue` payload。
- 不再发送旧的 `story.completed.continuedStory/model/elapsedMs/usage` 平铺字段。

## 数据库设计

### `storyline`

```ts
export const storylines = sqliteTable(
  "storyline",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("storyline_user_id_updated_at_idx").on(table.userId, table.updatedAt),
  ],
);
```

说明：

- `userId` 使用现有 `user.id` 外键。
- `updatedAt` 在每次成功保存 generated segment 时更新。
- `GET /storylines/recent` 按 `updatedAt desc, id desc` 查询当前用户最近一条。
- 对外返回 `id` 时使用 `String(storyline.id)`。

### `storyline_segment`

```ts
export const storylineSegments = sqliteTable(
  "storyline_segment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    type: text("type", { enum: ["initial", "generated"] }).notNull(),
    text: text("text").notNull(),
    instruction: text("instruction"),
    model: text("model"),
    elapsedMs: integer("elapsed_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_segment_storyline_order_unique").on(
      table.storylineId,
      table.orderIndex,
    ),
    index("storyline_segment_storyline_id_idx").on(table.storylineId),
  ],
);
```

说明：

- `type: "initial"` 的行保存初始故事正文。
- `type: "generated"` 的行保存 Agent 续写正文。
- `orderIndex` 从 `0` 开始递增。
- `initial` segment 的 `instruction`、`model`、`elapsedMs`、token 字段为空。
- `generated` segment 的 `instruction`、`model`、`elapsedMs`、token 字段必须由 service 保证存在。
- SQLite 层不强制复杂条件约束，由 service 单元测试覆盖。
- 对外返回 `id` 时使用 `String(segment.id)`。

## Env 设计

`Env` 增加 Story 配置：

```ts
type StoryEnvShape = Readonly<{
  historyRoundLimit: number;
}>;

type EnvShape = Readonly<{
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  llm: LlmEnvShape | null;
  story: StoryEnvShape;
}>;
```

解析规则：

- 环境变量名：`STORY_HISTORY_ROUND_LIMIT`。
- 默认值：`20`。
- 必须为正整数。
- 非整数、0、负数时启动失败。
- `reloadEnvForTesting()` 需要覆盖该配置。

示例：

```env
STORY_HISTORY_ROUND_LIMIT=20
```

## HTTP 接口设计

### `GET /storylines/recent`

Controller：

```ts
@Controller("storylines")
export class StorylineController {
  constructor(private readonly storylineService: StorylineService) {}

  @Get("recent")
  @UseGuards(JwtAuthGuard)
  getRecent(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GetRecentStorylineResponse> {
    return this.storylineService.getRecentStoryline(user.userId);
  }
}
```

处理流程：

1. `JwtAuthGuard` 验证 Bearer token。
2. 使用 `CurrentUser` 获取 `user.userId`。
3. `StorylineService.getRecentStoryline(user.userId)` 查询当前用户最近故事线。
4. 如果不存在，返回 `{ storyline: null }`。
5. 如果存在，加载该故事线所有 segment，映射为 `StorylineSnapshot`。

响应规则：

- `200`：返回符合 `GetRecentStorylineResponseSchema` 的响应体。
- `401`：鉴权失败，沿用现有 `JwtAuthGuard` 行为。
- 其他异常由 Nest 默认异常过滤处理。

快照映射：

```ts
type StorylineSnapshot = {
  id: string;
  segments: StorylineSegment[];
  latestGeneration: StorylineGenerationMetadata | null;
  updatedAt: string;
};
```

说明：

- `segments` 按 `orderIndex asc` 返回。
- `updatedAt` 使用 ISO datetime 字符串。
- `latestGeneration` 取 `orderIndex` 最大的 generated segment 元数据。
- 如果故事线只有 initial segment，`latestGeneration` 为 `null`。

## WebSocket 协议处理

### 客户端消息：`story.continue`

004 后服务端只接受：

```ts
type StoryContinueClientMessage = {
  type: "story.continue";
  requestId: string;
  payload:
    | {
        mode: "create";
        initialStoryText: string;
        instruction: string;
      }
    | {
        mode: "append";
        storylineId: string;
        instruction: string;
      };
};
```

校验规则：

- 使用 `StoryRealtimeClientMessageSchema.safeParse`。
- 旧 `{ storyText, instruction }` payload 不再兼容，会返回 `INVALID_PAYLOAD`。
- `mode: "create"` 校验 `initialStoryText` 和 `instruction`。
- `mode: "append"` 校验 `storylineId` 和 `instruction`。

### 服务端事件：`story.completed`

004 后 completed 只在生成成功且保存成功后发送：

```ts
type StoryCompletedServerEvent = {
  type: "story.completed";
  requestId: string;
  storyline: CompletedStorylineSnapshot;
  generatedSegmentId: string;
};
```

说明：

- `storyline` 是保存成功后的最新完整快照。
- `generatedSegmentId` 指向本轮新增 generated segment。
- 不再返回旧的平铺 `continuedStory`、`model`、`elapsedMs`、`usage` 字段。

### 错误码扩展

新增：

- `STORYLINE_NOT_FOUND`：故事线不存在、已删除或不属于当前用户。
- `STORYLINE_BUSY`：同一故事线或同一用户 create 已有活跃生成。
- `STORYLINE_SAVE_FAILED`：LLM 已完成，但保存故事线历史失败。

错误文案：

```ts
const errorMessages: Record<RealtimeErrorCode, string> = {
  INVALID_MESSAGE: "消息格式不正确",
  INVALID_PAYLOAD: "请求参数不正确",
  BUSY: "当前连接已有生成任务",
  NO_ACTIVE_TASK: "当前没有可取消的生成任务",
  GENERATION_FAILED: "生成失败，请稍后重试",
  LLM_EMPTY_RESPONSE: "生成结果为空，请稍后重试",
  LLM_USAGE_MISSING: "生成元数据缺失，请稍后重试",
  STORYLINE_NOT_FOUND: "故事线不存在",
  STORYLINE_BUSY: "当前故事线正在生成，请稍后重试",
  STORYLINE_SAVE_FAILED: "保存失败，请稍后重试",
};
```

## 生成编排设计

新增 `StorylineGenerationService`：

```ts
export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;

streamContinueStoryline(
  input: Readonly<{
    userId: string;
    payload: StoryContinuePayload;
  }>,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StorylineStreamEvent>
```

### create 流程

1. 校验 payload 为 `mode: "create"`。
2. 使用 `StorylineLockService.acquireCreateLock(userId)`。
3. 构造 prompt 上下文：
   - initial 正文来自 `payload.initialStoryText`。
   - 历史轮次为空。
   - 当前指令来自 `payload.instruction`。
4. 调用 StoryAgent LLM 流式生成。
5. 向 RealtimeGateway 逐个产出 chunk。
6. LLM completed 后校验正文、model、usage。
7. 在 SQLite 事务中：
   - 插入 `storyline`。
   - 插入 `initial` segment，`orderIndex = 0`。
   - 插入 `generated` segment，`orderIndex = 1`，保存 instruction 和元数据。
   - 更新 `storyline.updatedAt`。
8. 重新读取并映射最新 `CompletedStorylineSnapshot`。
9. 产出 `completed` 事件。
10. finally 中释放 create 锁。

### append 流程

1. 校验 payload 为 `mode: "append"`。
2. 将 `payload.storylineId` 解析为内部数字 ID。
3. 查询故事线，确认归属当前 `userId`。
4. 不存在或不属于当前用户时，返回 `STORYLINE_NOT_FOUND`。
5. 使用 `StorylineLockService.acquireStorylineLock(storylineId)`。
6. 读取最近 N 轮历史上下文。
7. 构造 StoryAgent prompt。
8. 调用 LLM 流式生成。
9. 向 RealtimeGateway 逐个产出 chunk。
10. LLM completed 后校验正文、model、usage。
11. 在 SQLite 事务中：
    - 重新读取当前最大 `orderIndex`。
    - 插入新的 `generated` segment。
    - 保存 instruction、model、elapsedMs、token usage。
    - 更新 `storyline.updatedAt`。
12. 重新读取并映射最新 `CompletedStorylineSnapshot`。
13. 产出 `completed` 事件。
14. finally 中释放 storyline 锁。

说明：

- append 保存前重新读取最大 `orderIndex`，避免使用生成开始前的陈旧序号。
- 进程内锁保证同一进程内不会出现同一故事线两个 append 同时保存。
- SQLite 事务保证保存成功要么完整写入，要么完全回滚。

## 进程内锁设计

`StorylineLockService` 管理两类锁：

```ts
type StorylineLockKey = `create:${string}` | `storyline:${string}`;
```

规则：

- `create:{userId}` 锁住同一用户的首轮 create。
- `storyline:{storylineId}` 锁住同一故事线的 append。
- acquire 失败时抛出领域错误，由 RealtimeGateway 映射为 `STORYLINE_BUSY`。
- release 必须幂等。
- completed、error、cancel、断连都必须释放。
- 本期使用进程内 `Set<string>` 或 `Map<string, ActiveLock>`。
- 不做跨进程锁，不做数据库 stale lock。

与 RealtimeGateway 单连接 busy 的关系：

- RealtimeGateway 继续维护单连接 `activeTask`，防止同一连接同时发起多个任务。
- StorylineLockService 负责跨连接、跨标签页、同一用户 create、同一故事线 append 的业务并发。
- 单连接 busy 返回 `BUSY`。
- Storyline 锁冲突返回 `STORYLINE_BUSY`。

## Prompt 设计

继续使用 `STORY_SYSTEM_PROMPT` 作为 system prompt，并新增 Storyline 上下文 user prompt。

### create prompt

```text
当前故事正文：
{initialStoryText}

当前续写指令：
{instruction}
```

### append prompt

窗口内轮次未超过 `STORY_HISTORY_ROUND_LIMIT` 时：

```text
故事正文：
{initialText}

近期续写轨迹：
第 1 轮指令：
{instruction1}

第 1 轮续写：
{generatedText1}

...

当前续写指令：
{currentInstruction}
```

窗口内轮次超过 `STORY_HISTORY_ROUND_LIMIT` 时：

```text
近期故事正文片段：
第 {roundIndex} 轮续写：
{generatedText}

...

近期续写指令轨迹：
第 {roundIndex} 轮指令：
{instruction}

...

当前续写指令：
{currentInstruction}
```

规则：

- 历史窗口按 generated 轮次数计算。
- N 来自 `Env.story.historyRoundLimit`。
- 当前待生成指令不计入历史窗口。
- 当总轮数 `<= N` 时，包含 initial 正文和全部 generated 轮次。
- 当总轮数 `> N` 时，只包含最近 N 个 generated segment 及其 instruction。
- 不把 UI 分隔符放入 prompt。
- 不把用户 ID、用户名放入 prompt。
- 不把模型、耗时、Token 放入 prompt。
- 不额外按字符或 token 裁剪 prompt。

## StoryService 调整

当前 `StoryService.streamContinueStory` 接受旧 `ContinueStoryRequest`。004 中建议调整为更内部化的接口：

```ts
export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly historyRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}

export interface StoryHistoryRound {
  readonly roundIndex: number;
  readonly instruction: string;
  readonly generatedText: string;
}

streamContinueStoryFromContext(
  context: StoryLlmContext,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent>
```

说明：

- `StoryService` 继续负责 StoryAgent prompt 和 LLM 流式调用。
- `StorylineService` 负责从数据库构造 `StoryLlmContext`。
- `StorylineGenerationService` 负责锁、调用、保存和快照。
- `streamContinueStoryFromContext` 使用 `LlmService.streamTextFromParsedRequest` 内部入口。
- 不调用公开 `GenerateLlmTextRequestSchema.safeParse`，避免被公开 LLM 接口的 prompt 长度限制拦截。

## 保存与快照映射

`StorylineService` 提供：

```ts
getRecentStoryline(userId: string): Promise<GetRecentStorylineResponse>;

getStorylineForUser(
  userId: string,
  storylineId: string,
): Promise<StorylineRecord | null>;

buildLlmContext(
  storylineId: string,
  historyRoundLimit: number,
): Promise<StoryLlmContext>;

saveCreatedStoryline(
  input: SaveCreatedStorylineInput,
): Promise<CompletedStorylineSnapshot>;

saveAppendedSegment(
  input: SaveAppendedSegmentInput,
): Promise<CompletedStorylineSnapshot>;
```

保存失败处理：

- 如果事务中任一步失败，抛出 `StorylineSaveFailedError`。
- RealtimeGateway 或 generation service 将其映射为 `STORYLINE_SAVE_FAILED`。
- 不发送 completed。
- 不保存 partial segment。

快照映射规则：

- `storyline.id` -> `String(id)`。
- `segment.id` -> `String(id)`。
- `updatedAt` -> `updatedAt.toISOString()`。
- `initial` segment 映射 `{ id, type: "initial", text }`。
- `generated` segment 映射 `{ id, type: "generated", text }`。
- `latestGeneration` 从最后一个 generated segment 映射：

```ts
{
  segmentId: String(segment.id),
  model: segment.model,
  elapsedMs: segment.elapsedMs,
  usage: {
    inputTokens: segment.inputTokens,
    outputTokens: segment.outputTokens,
    totalTokens: segment.totalTokens,
  },
}
```

## RealtimeGateway 调整

`RealtimeGateway` 继续承担 WebSocket 边界职责：

- 鉴权。
- 消息解析。
- 单连接 active task。
- cancel。
- 断连 abort。
- 事件发送。

调整点：

- 注入 `StorylineGenerationService`。
- 鉴权后在 client state 中记录 `user.sub`。
- 收到 `story.continue` 后调用：

```ts
this.storylineGenerationService.streamContinueStoryline(
  {
    userId: clientState.user.sub,
    payload: message.payload,
  },
  { signal: abortController.signal },
);
```

- chunk 映射为 `story.chunk`。
- completed 映射为新的 `story.completed`。
- `StorylineNotFoundError` 映射 `STORYLINE_NOT_FOUND`。
- `StorylineBusyError` 映射 `STORYLINE_BUSY`。
- `StorylineSaveFailedError` 映射 `STORYLINE_SAVE_FAILED`。

取消规则：

- 收到匹配 `story.cancel` 后 abort LLM。
- 不保存当前临时文本。
- 发送 `story.cancelled`。
- 清理 active task。
- release StorylineLockService 锁。

断连规则：

- 断连时 abort LLM。
- 不保存当前临时文本。
- 不发送事件。
- 清理 active task。
- release StorylineLockService 锁。

## 错误处理

HTTP：

- `GET /storylines/recent` 未登录返回 `401`。
- 查询成功但无数据返回 `{ storyline: null }`。
- 数据库异常返回 `500`，前端展示恢复失败页。

WebSocket：

- 缺失或非法 token：关闭连接，code `1008`。
- 非 JSON：`INVALID_MESSAGE`。
- schema 不合法：`INVALID_PAYLOAD`。
- 同连接已有任务：`BUSY`。
- 同用户 create 或同故事线 append 活跃：`STORYLINE_BUSY`。
- append 的故事线不存在或不属于当前用户：`STORYLINE_NOT_FOUND`。
- LLM provider 异常：`GENERATION_FAILED`。
- LLM 空输出：`LLM_EMPTY_RESPONSE`。
- LLM usage 缺失：`LLM_USAGE_MISSING`。
- 保存失败：`STORYLINE_SAVE_FAILED`。

日志：

- 可以记录 requestId、userId、storylineId、错误类型。
- 不记录完整初始正文。
- 不记录完整续写指令。
- 不记录完整模型输出。

## 安全与权限

- HTTP 恢复接口必须使用 `JwtAuthGuard`。
- WebSocket 建连必须校验 `accessToken`。
- append 时必须校验故事线归属当前用户。
- `GET /storylines/recent` 只能返回当前用户自己的故事线。
- create 时 userId 来自服务端鉴权上下文，不能由客户端传入。
- prompt 中不包含 userId、uniqueName 或认证信息。

## 测试方案

### Schema 测试

覆盖：

- `StoryContinuePayloadSchema` 接受 create payload。
- `StoryContinuePayloadSchema` 接受 append payload。
- 旧 `{ storyText, instruction }` payload 被拒绝。
- `StoryCompletedServerEventSchema` 接受包含 `storyline` 快照的 completed 事件。
- 新错误码被 `StoryRealtimeErrorCodeSchema` 接受。

### Env 测试

`env.spec.ts` 覆盖：

- 未配置 `STORY_HISTORY_ROUND_LIMIT` 时默认 `20`。
- 正整数配置成功。
- `0`、负数、非数字、浮点数启动失败。
- `reloadEnvForTesting()` 能刷新配置。

### StorylineService 单元测试

覆盖：

- 无故事线时 `getRecentStoryline` 返回 `{ storyline: null }`。
- 多条故事线时按 `updatedAt desc, id desc` 返回最近一条。
- 快照按 `orderIndex asc` 返回 segments。
- latestGeneration 取最后一个 generated segment。
- create 保存会在事务中写入 storyline、initial、generated。
- append 保存会追加 generated，并更新 `updatedAt`。
- 保存失败时不返回 completed 快照。
- append 不允许访问其他用户故事线。
- historyRoundLimit 未超过总轮数时，上下文包含 initial 和全部轮次。
- historyRoundLimit 小于总轮数时，上下文只包含最近 N 个 generated 轮次。

### StorylineLockService 单元测试

覆盖：

- 同一用户 create 锁互斥。
- 不同用户 create 锁不互斥。
- 同一 storyline append 锁互斥。
- 不同 storyline append 锁不互斥。
- release 幂等。
- acquire 冲突抛出可映射为 `STORYLINE_BUSY` 的错误。

### StoryService 单元测试

覆盖：

- create context prompt 包含 initial 正文和当前指令。
- append 未裁剪 context prompt 包含 initial、历史 instruction、历史 generated、当前指令。
- append 已裁剪 context prompt 不包含 initial。
- prompt 不包含 UI 分隔符。
- prompt 不包含元数据。
- LLM chunk 被按 sequence 产出。
- LLM empty output 抛出 `BadGatewayException`。
- LLM usage 缺失抛出 `BadGatewayException`。

### RealtimeGateway 单元测试

覆盖：

- 旧 payload 返回 `INVALID_PAYLOAD`。
- create payload 调用 StorylineGenerationService。
- append payload 调用 StorylineGenerationService。
- 单连接并发返回 `BUSY`。
- Storyline busy 映射 `STORYLINE_BUSY`。
- Storyline not found 映射 `STORYLINE_NOT_FOUND`。
- 保存失败映射 `STORYLINE_SAVE_FAILED`。
- completed 事件包含 `storyline` 和 `generatedSegmentId`。
- cancel 会 abort 并发送 `story.cancelled`。
- disconnect 会 abort 且不发送 completed。

### E2E 测试

HTTP：

- 未登录 `GET /storylines/recent` 返回 `401`。
- 登录后无故事线返回 `{ storyline: null }`。
- 登录后有故事线返回符合 `GetRecentStorylineResponseSchema` 的快照。
- 用户 A 不能恢复用户 B 的故事线。

WebSocket：

- 未带 token 建连关闭 `1008`。
- create 成功后返回 chunk 和 completed。
- create completed 中返回新 `storyline.id`、initial segment、generated segment、latestGeneration。
- append 成功后返回包含新增 generated segment 的快照。
- append 不提交完整正文。
- append 非本人故事线返回 `STORYLINE_NOT_FOUND`。
- 同故事线并发 append 返回 `STORYLINE_BUSY`。
- 同用户并发 create 返回 `STORYLINE_BUSY`。
- cancel 后不写入 generated segment。
- LLM completed 但保存失败返回 `STORYLINE_SAVE_FAILED`，不发送 completed。

## 验证命令

实现完成后执行：

```bash
pnpm --filter @kimiko/schema typecheck
pnpm --filter @kimiko/schema lint
pnpm --filter @kimiko/server typecheck
pnpm --filter @kimiko/server lint
pnpm --filter @kimiko/server test
pnpm --filter @kimiko/server test:e2e
```

如前端实现已同步，也需要执行：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```
