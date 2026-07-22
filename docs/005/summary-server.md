# 引入故事线角色摘要服务端技术方案

## 背景

本文档对应 PRD：[summary.md](./summary.md) 和前端技术方案：[summary-fe.md](./summary-fe.md)，并基于上一期故事线历史服务端技术方案：[../004/history-server.md](../004/history-server.md)。

本期目标是在服务端引入故事线角色摘要能力：每轮正文流式生成完成后，服务端基于旧角色摘要、初始/近期上下文、本轮续写指令和本轮生成正文，生成新的重要角色摘要快照；摘要和本轮 generated segment 在同一个 SQLite 事务中保存；保存成功后才发送 `story.completed`。

## IDL 结论

已读取前端技术方案 [summary-fe.md](./summary-fe.md) 中的 IDL Schema。本服务端技术方案沿用前端技术方案中的 IDL，不需要修改，因此不额外输出 `summary-fe-idl-change.md`。

服务端需要在 `packages/schema/src/index.ts` 中实现并使用前端技术方案定义的契约：

- 新增 `StorySummaryStartedServerEventSchema`
- 新增 `StorySummaryStartedServerEvent`
- `StoryRealtimeServerEventSchema` union 增加 `StorySummaryStartedServerEventSchema`
- `StoryRealtimeErrorCodeSchema` 增加 `STORY_SUMMARY_FAILED`

关键事件顺序：

```text
story.started
-> story.chunk*
-> story.summary.started
-> story.completed | story.cancelled | story.error
```

`story.completed`、`GET /storylines/recent`、`story.continue` 和 `story.cancel` 契约保持不变。角色摘要内容不返回前端，不进入 `StorylineSnapshot`。

## 已确认决策

- 一期只做重要角色摘要，不做完整 CanonSnapshot。
- 一期不做世界观规则、事件时间线、任务、伏笔等结构化管理。
- 一期不做 Validator 或 Repair。
- 一期不引入多 Agent 自治协作。
- 角色摘要对前端不可见，只由服务端注入后续 Writer prompt。
- 正文生成完成后，服务端发送 `story.summary.started`。
- `story.summary.started` 后不再发送 `story.chunk`。
- 摘要生成和保存成功后才发送 `story.completed`。
- 摘要失败时发送 `STORY_SUMMARY_FAILED`，不发送 `story.completed`。
- 摘要失败时本轮正文不进入正式故事线历史。
- 用户在摘要阶段取消或断连时，中止整轮，不保存 segment 和 summary。
- 同一故事线锁覆盖 Writer 生成、Extractor 摘要和事务保存全过程。
- Create 锁覆盖同一用户首轮 Writer 生成、Extractor 摘要和事务保存全过程。
- 角色摘要使用独立表保存当前快照。
- 摘要表每条故事线最多一条当前快照。
- 摘要内容以 JSON 文本保存，并由服务端 zod schema 校验。
- 允许空角色列表。
- 首轮 create 摘要输入包含初始故事正文、首轮续写指令和首轮生成正文。
- 后续 append 摘要输入包含旧角色摘要、最近历史上下文、本轮续写指令和本轮生成正文。
- 一期由 Extractor 直接输出完整当前摘要快照，服务端只负责校验并覆盖保存。
- Writer prompt 中，角色摘要放在系统规则之后、最近历史之前。
- 本期不新增服务端第三方依赖。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 Drizzle ORM + SQLite。
- 启动时 `DatabaseModule` 会执行 Drizzle migration。
- WebSocket 使用原生 `ws`，通过 Nest `@WebSocketGateway({ path: "/realtime" })` 暴露。
- WebSocket 鉴权使用查询参数 `accessToken`。
- WebSocket 中 `RealtimeGateway` 已能通过 `verifyAccessToken` 得到 `sub` 和 `uniqueName`。
- 当前 Storyline 持久化使用 `storyline` 和 `storyline_segment` 表。
- 当前 `StorylineGenerationService` 负责 WebSocket create/append 编排。
- 当前 `StorylineLockService` 已提供用户级 create 锁和故事线级 append 锁。
- 当前 `StoryService.streamContinueStoryFromContext` 负责流式 Writer 调用。
- 当前 `LlmService.generateTextFromParsedRequest` 可用于非流式 LLM 调用，但尚未支持 `AbortSignal`。
- 当前 `LlmProvider.generateText` 尚未支持 `AbortSignal`。

## 新增和调整文件

新增文件：

- `packages/server/src/storyline/storyline-summary.service.ts`
  - 负责角色摘要 Extractor prompt 构造、LLM 调用、JSON 解析、schema 校验。
- `packages/server/src/storyline/storyline-summary.types.ts`
  - 定义服务端内部角色摘要类型、Extractor 输入类型。
- `packages/server/src/storyline/storyline-summary.service.spec.ts`
  - 覆盖摘要 prompt、JSON 解析、schema 校验、失败映射。

调整文件：

- `packages/schema/src/index.ts`
  - 新增 `StorySummaryStartedServerEventSchema`。
  - 扩展 `StoryRealtimeServerEventSchema`。
  - 扩展 `StoryRealtimeErrorCodeSchema`。
- `packages/server/src/database/schema/storylines.schema.ts`
  - 新增 `storyline_summary` 表。
  - 导出表类型。
- `packages/server/src/database/schema/index.ts`
  - 确保导出新增 summary 表。
- `packages/server/src/storyline/storyline.module.ts`
  - 注册 `StorylineSummaryService`。
- `packages/server/src/storyline/storyline.types.ts`
  - 扩展 `StorylineStreamEvent`，增加 `summaryStarted` 事件。
  - 增加带角色摘要的保存输入类型。
- `packages/server/src/storyline/storyline.errors.ts`
  - 新增 `StorySummaryFailedError`。
- `packages/server/src/storyline/storyline.service.ts`
  - 查询当前角色摘要。
  - `buildLlmContext` 注入角色摘要。
  - 提供保存 generated segment 和 summary 的事务方法。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - Writer completed 后 yield `summaryStarted`。
  - 调用 `StorylineSummaryService` 生成角色摘要。
  - 摘要成功后事务保存 segment 和 summary。
  - 摘要失败时抛出 `StorySummaryFailedError`。
- `packages/server/src/story/story.service.ts`
  - `StoryLlmContext` 增加可选角色摘要字段。
  - Writer prompt 在最近历史前注入角色摘要。
- `packages/server/src/realtime/realtime.gateway.ts`
  - 将 `summaryStarted` 映射为 `story.summary.started`。
  - `errorMessages` 增加 `STORY_SUMMARY_FAILED` 的通用失败文案。
  - `mapStreamErrorCode` 增加 `StorySummaryFailedError` 映射。
- `packages/server/src/realtime/realtime.types.ts`
  - `RealtimeErrorCode` 增加 `STORY_SUMMARY_FAILED`。
- `packages/server/src/llm/llm.provider.ts`
  - `generateText` 增加可选 `AbortSignal` 参数。
- `packages/server/src/llm/llm.service.ts`
  - `generateTextFromParsedRequest` 增加可选 `AbortSignal` 参数。
  - HTTP 公开 `generateText` 可以继续不传 signal。
- `packages/server/src/llm/llm.providers.ts`
  - `UnspecifiedProvider.generateText` 签名同步。
- `packages/server/src/llm/openai-compatible.provider.ts`
  - 非流式 completion 调用支持传入 `signal`。
- `packages/server/drizzle/*`
  - 通过 `pnpm --filter @kimiko/server db:generate` 生成新迁移。

测试新增或调整：

- `packages/server/src/storyline/storyline.service.spec.ts`
  - 补充 summary 查询、summary 注入、同事务保存测试。
- `packages/server/src/storyline/storyline-generation.service.spec.ts`
  - 补充 summary started、summary 失败、summary 阶段取消、锁释放测试。
- `packages/server/test/realtime.e2e-spec.ts`
  - 补充 `story.summary.started` 和 `STORY_SUMMARY_FAILED` 链路。
- `packages/server/src/llm/llm.service.spec.ts`
  - 补充非流式调用传递 `AbortSignal`。
- `packages/server/src/llm/openai-compatible.provider.spec.ts`
  - 补充非流式 completion 传递 `signal`。

## 数据库设计

### `storyline_summary`

```ts
export const storylineSummaries = sqliteTable(
  "storyline_summary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    charactersJson: text("characters_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_summary_storyline_id_unique").on(
      table.storylineId,
    ),
  ],
);
```

说明：

- 每条故事线最多一条 summary 当前快照。
- `charactersJson` 保存内部 JSON，不直接暴露给前端。
- `storylineId` 使用 cascade delete，删除故事线时自动删除摘要。
- `updatedAt` 表示当前摘要更新时间。
- 本期不保存每轮摘要历史版本。
- 本期不需要给角色单独建表。

## 内部摘要 Schema

角色摘要不进入共享前端 IDL，可以放在服务端内部文件中。

```ts
export const StoryCharacterSummarySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(5),
    identity: z.string().trim().min(1).max(240),
    relationships: z.array(z.string().trim().min(1).max(240)).max(12),
    motivation: z.string().trim().max(240),
    currentStatus: z.string().trim().max(240),
  })
  .strict();

export const StoryCharacterSummarySnapshotSchema = z
  .object({
    characters: z.array(StoryCharacterSummarySchema).max(12),
  })
  .strict();
```

类型：

```ts
export type StoryCharacterSummary = z.infer<
  typeof StoryCharacterSummarySchema
>;

export type StoryCharacterSummarySnapshot = z.infer<
  typeof StoryCharacterSummarySnapshotSchema
>;
```

说明：

- `characters` 允许为空数组。
- `name` 表示主要姓名或称呼。
- `aliases` 表示别名、称号、昵称。
- `identity` 表示身份、阵营或稳定定位。
- `relationships` 表示和其他重要角色的关键关系。
- `motivation` 表示稳定动机；没有明确动机时允许空字符串。
- `currentStatus` 表示当前处境、状态、目标位置或行动阶段；没有明确状态时允许空字符串。
- 服务端保存前必须先通过 zod 校验。
- 超出数量或长度限制视为摘要失败。

## Extractor 设计

### 服务接口

```ts
export interface GenerateCharacterSummaryInput {
  readonly previousSummary: StoryCharacterSummarySnapshot | null;
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}

@Injectable()
export class StorylineSummaryService {
  constructor(private readonly llmService: LlmService) {}

  async generateCharacterSummary(
    input: GenerateCharacterSummaryInput,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<StoryCharacterSummarySnapshot>;
}
```

说明：

- 首轮 create 时 `previousSummary` 为 `null`。
- 首轮 create 时传入 `initialStoryText`、`currentInstruction`、`generatedText`。
- 后续 append 时传入旧摘要、最近历史、本轮指令、本轮生成正文。
- 不传完整故事线，避免 token 成本失控。
- Extractor 直接输出完整当前快照，不输出 delta。

### Extractor Prompt 规则

系统规则建议：

```text
你是 StoryAgent 的角色摘要维护器。
你只负责维护重要角色摘要，不负责续写正文。
你必须只输出 JSON，不输出解释、Markdown 或额外文本。
你只能根据输入中的旧角色摘要、历史片段、当前指令和本轮正文更新摘要。
不要创造输入中没有依据的新角色事实。
只记录重要角色，忽略路人和一次性背景人物。
输出必须符合指定 JSON schema。
```

用户 prompt 分层：

```text
旧角色摘要：
{previousSummaryJson 或 "无"}

初始故事正文：
{initialStoryText 可选}

近期故事上下文：
{recentHistoryRounds}

本轮续写指令：
{currentInstruction}

本轮生成正文：
{generatedText}

请输出新的完整角色摘要快照。
```

输出 JSON 形状：

```json
{
  "characters": [
    {
      "name": "角色名",
      "aliases": ["别名"],
      "identity": "身份或稳定定位",
      "relationships": ["与其他角色的关键关系"],
      "motivation": "稳定动机",
      "currentStatus": "当前处境或状态"
    }
  ]
}
```

### JSON 解析

解析规则：

- 先 `trim()`。
- 只接受纯 JSON 对象。
- 不接受 Markdown 代码块。
- 不接受 JSON 前后附加解释文本。
- `JSON.parse` 失败时抛出 `StorySummaryFailedError`。
- zod schema 校验失败时抛出 `StorySummaryFailedError`。
- LLM 空响应时抛出 `StorySummaryFailedError`。

本期不做自动重试，不做 repair prompt。

## Writer Prompt 注入

`StoryLlmContext` 增加角色摘要：

```ts
export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly historyRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}
```

`buildStoryUserPromptFromContext` 中的顺序：

```text
角色摘要：
{characterSummary}

故事正文 / 近期续写轨迹：
{initialStoryText + historyRounds}

当前续写指令：
{currentInstruction}
```

说明：

- 角色摘要放在用户 prompt 内，不放进 `STORY_SYSTEM_PROMPT`。
- 顺序上位于最近历史之前，用作长期连续性约束。
- 如果没有摘要或 `characters` 为空，可以省略角色摘要区块。
- 最近 N 轮历史仍然保留，用于语气、节奏和局部上下文。
- 摘要不替代 `STORY_HISTORY_ROUND_LIMIT`。

## 生成编排

### Create 流程

```text
acquire user create lock
-> Writer stream start
-> yield chunk*
-> Writer completed
-> yield summaryStarted
-> Extractor 生成角色摘要
-> SQLite transaction:
   - insert storyline
   - insert initial segment
   - insert generated segment
   - insert storyline_summary
-> 读取 completed snapshot
-> yield completed
-> release lock
```

说明：

- `story.summary.started` 在 Writer completed 后立即发出。
- 摘要生成前不写入数据库。
- 摘要失败时不创建 storyline，不保存 initial segment，不保存 generated segment。

### Append 流程

```text
get storyline for user
-> acquire storyline lock
-> build LLM context:
   - current character summary
   - initialStoryText 可选
   - recent history rounds
   - current instruction
-> Writer stream start
-> yield chunk*
-> Writer completed
-> yield summaryStarted
-> Extractor 生成新的完整角色摘要快照
-> SQLite transaction:
   - insert generated segment
   - upsert storyline_summary
   - update storyline.updatedAt
-> 读取 completed snapshot
-> yield completed
-> release lock
```

说明：

- 摘要失败时不插入 generated segment。
- 保存失败时不发送 completed。
- `updatedAt` 只在 segment 和 summary 都保存成功时更新。

## 事务保存设计

建议替换现有 `saveCreatedStoryline` / `saveAppendedSegment` 或新增等价方法：

```ts
async saveCreatedStorylineWithSummary(
  input: SaveCreatedStorylineWithSummaryInput,
): Promise<CompletedStorylineSnapshot>;

async saveAppendedSegmentWithSummary(
  input: SaveAppendedSegmentWithSummaryInput,
): Promise<CompletedStorylineSnapshot>;
```

输入需要包含：

- 用户 ID
- 初始正文或故事线 ID
- 本轮指令
- 本轮 generated text
- 模型、耗时、usage
- `StoryCharacterSummarySnapshot`

保存规则：

- Create 使用一个事务保存 storyline、initial segment、generated segment、summary。
- Append 使用一个事务保存 generated segment、summary、storyline.updatedAt。
- Append summary 使用 upsert：
  - 已存在则更新 `charactersJson` 和 `updatedAt`。
  - 不存在则插入新行。
- 事务失败统一抛出 `StorylineSaveFailedError`。
- 摘要 schema 校验应在事务前完成。

## Realtime 事件映射

`StorylineStreamEvent` 增加：

```ts
export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{ type: "summaryStarted" }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;
```

`RealtimeGateway.sendStoryStreamEvent` 增加分支：

```ts
if (event.type === "summaryStarted") {
  sendEvent(client, {
    type: "story.summary.started",
    requestId,
  });
  return;
}
```

错误码映射：

```ts
if (error instanceof StorySummaryFailedError) {
  return "STORY_SUMMARY_FAILED";
}
```

错误文案：

```ts
STORY_SUMMARY_FAILED: "生成失败，请稍后重试",
```

说明：

- 前端不需要知道摘要失败细节。
- 后端日志可以记录具体失败原因，但 WebSocket 只返回通用文案。

## 取消与断连

取消和断连都通过当前 `AbortController` 传递。

需要调整：

- `LlmProvider.generateText(input, options)` 支持 `AbortSignal`。
- `LlmService.generateTextFromParsedRequest(request, options)` 支持 `AbortSignal`。
- `OpenAiCompatibleProvider.createChatCompletion` 调用非流式 completion 时传入 `{ signal }`。
- `StorylineSummaryService.generateCharacterSummary` 必须接收并传递 `signal`。

处理规则：

- Writer 阶段取消：停止流式生成，不保存任何内容。
- Summary 阶段取消：停止摘要生成，不保存 segment 和 summary。
- Summary 阶段断连：同取消处理，不保存 segment 和 summary。
- 取消路径不发送 `story.error`。
- 锁必须在 finally 中释放。

## 错误处理

### `STORY_SUMMARY_FAILED`

以下情况映射为 `STORY_SUMMARY_FAILED`：

- Extractor LLM 空响应。
- Extractor LLM 返回非 JSON。
- Extractor LLM 返回 JSON 前后夹杂解释文本。
- Extractor 输出不符合 `StoryCharacterSummarySnapshotSchema`。
- Extractor LLM provider 返回摘要生成失败。

说明：

- 不保存本轮 generated segment。
- 不更新 `storyline_summary`。
- 不发送 `story.completed`。

### `STORYLINE_SAVE_FAILED`

以下情况仍映射为 `STORYLINE_SAVE_FAILED`：

- segment 写入失败。
- summary 写入失败。
- `storyline.updatedAt` 更新失败。
- completed snapshot 读取失败或 latest generation 不匹配。

说明：

- 保存失败发生在事务中时，事务回滚。
- 不发送 `story.completed`。

## 测试计划

### 单元测试

`StorylineSummaryService`：

- 能基于旧摘要、历史、本轮指令、本轮正文构造 Extractor prompt。
- 能解析合法 JSON。
- 允许 `characters: []`。
- 拒绝非 JSON。
- 拒绝 Markdown 代码块。
- 拒绝超出角色数量限制。
- 拒绝字段超长。
- LLM 空响应映射为 `StorySummaryFailedError`。
- 传递 `AbortSignal` 给 `LlmService`。

`StorylineService`：

- `buildLlmContext` 能读取当前 summary。
- 有 summary 时 Writer prompt 上下文包含角色摘要。
- 无 summary 时正常构造历史上下文。
- create 时 segment 和 summary 同事务保存。
- append 时 segment 和 summary 同事务保存。
- append 时 summary upsert 更新当前快照。
- summary 保存失败时 generated segment 不落库。

`StorylineGenerationService`：

- Writer completed 后先 yield `summaryStarted`，再 yield `completed`。
- summary 失败时抛出 `StorySummaryFailedError`。
- summary 失败时不保存 generated segment。
- summary 阶段取消时不保存 generated segment 和 summary。
- create 锁覆盖 summary 阶段。
- append 锁覆盖 summary 阶段。
- completed 后释放锁。
- error、cancel、断连路径释放锁。

`RealtimeGateway`：

- `summaryStarted` 映射为 `story.summary.started`。
- `StorySummaryFailedError` 映射为 `STORY_SUMMARY_FAILED`。

`LlmService` / `OpenAiCompatibleProvider`：

- 非流式 `generateTextFromParsedRequest` 能向 provider 传递 signal。
- OpenAI 非流式 completion 调用能传入 `{ signal }`。
- HTTP `POST /llm/generate` 不传 signal 时行为保持不变。

### E2E 测试

- create 链路事件顺序为 `started -> chunk* -> summary.started -> completed`。
- append 链路事件顺序为 `started -> chunk* -> summary.started -> completed`。
- completed 后恢复最近故事线能看到本轮 generated segment。
- summary 阶段失败时收到 `story.error`，code 为 `STORY_SUMMARY_FAILED`。
- summary 阶段失败后恢复故事线，看不到失败轮次正文。
- summary 阶段取消后收到 `story.cancelled`。
- summary 阶段取消后恢复故事线，看不到取消轮次正文。
- 同一故事线 summary 阶段仍拒绝并发 append。

## 实施顺序

1. 更新 `packages/schema/src/index.ts`，实现前端技术方案中的 IDL。
2. 新增 `storyline_summary` Drizzle schema。
3. 运行 `pnpm --filter @kimiko/server db:generate` 生成迁移。
4. 新增内部角色摘要 schema 和 `StorylineSummaryService`。
5. 扩展 `LlmProvider` / `LlmService` / `OpenAiCompatibleProvider` 非流式 signal 支持。
6. 扩展 `StoryLlmContext` 和 Writer prompt 注入角色摘要。
7. 调整 `StorylineService`，增加 summary 查询和事务保存。
8. 调整 `StorylineGenerationService`，加入 `summaryStarted` 和 Extractor 编排。
9. 调整 `RealtimeGateway` 和 realtime 错误映射。
10. 补齐单元测试和 e2e 测试。
11. 运行验证：
    - `pnpm --filter @kimiko/schema build`
    - `pnpm --filter @kimiko/server typecheck`
    - `pnpm --filter @kimiko/server lint`
    - `pnpm --filter @kimiko/server test`
    - `pnpm --filter @kimiko/server test:e2e`
    - `pnpm --filter @kimiko/server build`

