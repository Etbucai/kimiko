# 复制故事服务端技术方案

## 背景

本文档对应：

- PRD：[storyline-copy-prd.md](./storyline-copy-prd.md)
- 前端技术方案：[storyline-copy-fe.md](./storyline-copy-fe.md)

013 需要提供一个同步 HTTP 能力：读取当前用户指定故事的第 1 章到第 N 章，在单个数据库事务中创建一条完全独立的新故事线，并让副本可以立即续写、互动和重写。

复制不能只处理正文。当前故事上下文及每个生成分段的 `previousContextJson` 都包含原分段 ID。新故事的分段获得新 ID 后，所有上下文来源引用必须同步重映射，否则副本会保留指向原故事的悬空或跨故事引用。

## 已确认决策

- 使用普通 HTTP 接口，不进入实时生成 WebSocket。
- 副本与原故事完全独立，不保存来源故事 ID。
- 复制 `chapterIndex <= N` 的全部分段，包括互动分段。
- 保留生成模式、指令、模型、耗时、Token、目标长度和历史上下文快照。
- 复制不超过 N 的最近安全结构化故事上下文。
- 如果不存在恰好截至 N 的完整快照，保留更早的安全游标和待提取轮次，不自动调用 LLM 补齐。
- 上下文中的所有分段来源 ID 重映射为副本分段 ID。
- 复制不调用 LLM。
- 复制与生成、重写、互动、上下文提取共用源故事的故事级锁。
- 获取锁失败时返回 `409`，不排队等待。
- 新故事保存显式标题；普通故事和旧数据继续从初始正文派生标题。
- 标题允许重复，不增加唯一索引。
- 复制使用数据库事务，任一步失败时不保留部分副本。
- 不实现服务端严格幂等；网络结果不确定时重试可能产生第二个副本。

## 非目标

- 不复制任务 registry 或后台任务状态。
- 不保存原故事 ID、分支章节或来源展示信息。
- 不修改现有 WebSocket payload。
- 不重新调用 LLM 提取上下文。
- 不实现标题编辑接口。
- 不实现复制任务队列或异步进度接口。
- 不实现跨用户复制。
- 不实现副本去重。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 SQLite、better-sqlite3 和 Drizzle。
- 共享契约集中在 `@kimiko/schema`。
- `storyline` 当前只保存用户 ID 和时间，不保存标题。
- `storyline_segment` 使用 `chapter_index` 表示章节。
- 同一章可以包含一个章节正文分段和多个互动分段。
- `storyline_context` 每条故事最多一行，通过 `extracted_through_order_index` 记录提取进度。
- 每个生成分段通过 `previous_context_json` 和 `previous_context_order_index` 保存生成前上下文，供重写和上下文回退使用。
- `StorylineLockService` 已为生成和上下文提取提供故事级内存锁。
- `StorylineSnapshot` 当前按章节窗口读取，不会返回完整长故事。
- 当前标题只在故事列表中从初始正文派生。

## 设计总览

```text
POST /storylines/:sourceStorylineId/copies
  -> JwtAuthGuard
  -> StorylineController
  -> StorylineCopyService
       1. 校验请求和故事归属
       2. 获取源故事锁
       3. 在事务内读取稳定源状态
       4. 校验 N
       5. 创建新故事
       6. 复制分段并建立 ID 映射
       7. 重映射每个 previousContextJson
       8. 选择并重映射截至 N 的当前上下文
       9. 提交事务
      10. 读取新故事最新章节窗口
  -> CopyStorylineResponse
```

建议新增独立 `StorylineCopyService`，避免继续扩大已经承担生成保存、上下文读取和快照映射的 `StorylineService`。

## 共享契约

### 标题

```ts
export const StorylineTitleSchema = z.string().trim().min(1).max(80);

export type StorylineTitle = z.infer<typeof StorylineTitleSchema>;
```

调整：

```ts
export const StorylineListItemSchema = z
  .object({
    id: StorylineIdSchema,
    title: StorylineTitleSchema,
    // ...
  })
  .strict();

export const StorylineSnapshotSchema = z
  .object({
    id: StorylineIdSchema,
    title: StorylineTitleSchema,
    chapters: /* existing */,
    chapterCount: /* existing */,
    anchorPage: /* existing */,
    latestGeneration: /* existing */,
    updatedAt: /* existing */,
  })
  .strict();
```

`CompletedStorylineSnapshotSchema` 自动继承 `title`。

### 请求

```ts
export const CopyStorylineRequestSchema = z
  .object({
    title: StorylineTitleSchema,
    throughChapter: z.number().int().positive(),
  })
  .strict();

export type CopyStorylineRequest = z.infer<typeof CopyStorylineRequestSchema>;
```

Schema 只校验 N 为正整数。`N <= source.chapterCount` 必须在持有锁后的数据库事务内校验。

### 响应

```ts
export const CopyStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema,
  })
  .strict();

export type CopyStorylineResponse = z.infer<typeof CopyStorylineResponseSchema>;
```

返回的新故事快照：

- `anchorPage = N`。
- `chapterCount = N`。
- 章节窗口使用现有 `STORYLINE_CHAPTER_CACHE_RADIUS`。
- N=1 且最后分段为 initial 时，`latestGeneration = null`。
- N>1 或第 N 章最后存在 generated 分段时，`latestGeneration` 指向副本的新分段 ID。

## HTTP 接口

```http
POST /storylines/:sourceStorylineId/copies
Authorization: Bearer <access token>
Content-Type: application/json
```

请求示例：

```json
{
  "title": "雾港来信（副本）",
  "throughChapter": 6
}
```

成功：

```http
HTTP/1.1 201 Created
```

```json
{
  "storyline": {
    "id": "42",
    "title": "雾港来信（副本）",
    "chapters": [
      {
        "pageNumber": 6,
        "segments": [
          {
            "id": "108",
            "type": "generated",
            "generationMode": "append",
            "text": "第六章正文"
          }
        ]
      }
    ],
    "chapterCount": 6,
    "anchorPage": 6,
    "latestGeneration": {
      "segmentId": "108",
      "model": "example-model",
      "elapsedMs": 1200,
      "usage": {
        "inputTokens": 100,
        "outputTokens": 200,
        "totalTokens": 300
      }
    },
    "updatedAt": "2026-08-01T12:00:00.000Z"
  }
}
```

示例只展示最后一章；正式实现按现有章节窗口规则返回，并且必须通过共享 schema。

### 状态码

| 状态码 | 场景                                         |
| ------ | -------------------------------------------- |
| `201`  | 创建成功                                     |
| `400`  | body 不合法，或 N 超过源故事总章节数         |
| `401`  | 未登录或认证失效                             |
| `404`  | 源故事不存在或不属于当前用户                 |
| `409`  | 源故事正在生成、重写、互动、复制或提取上下文 |
| `500`  | 数据损坏、上下文无法重映射或数据库保存失败   |

无权访问与真实不存在统一返回 `404`。

## Controller

在 `StorylineController` 增加：

```ts
@Post(":storylineId/copies")
@UseGuards(JwtAuthGuard)
copy(
  @CurrentUser() user: AuthenticatedUser,
  @Param("storylineId") storylineId: string,
  @Body() body: unknown,
): Promise<CopyStorylineResponse> {
  return this.storylineCopyService.copyStoryline({
    body,
    sourceStorylineId: storylineId,
    userId: user.userId,
  });
}
```

NestJS `@Post` 默认返回 `201`，不添加 `@HttpCode(200)`。

Controller 通过现有 `mapStorylineHttpError` 或扩展后的统一映射处理领域错误：

- `StorylineNotFoundError` -> `404`
- `StorylineBusyError` -> `409`
- `StorylineCopyChapterOutOfRangeError` -> `400`

请求 body 的 Zod 失败可以沿用现有 `BadRequestException` 格式。

## 数据库调整

### Schema

为 `storyline` 增加可空显式标题：

```ts
title: text("title"),
```

保持可空的原因：

- 历史故事没有显式标题。
- 普通创建流程本期不要求用户填写标题。
- `null` 明确表示继续从初始正文派生展示标题。
- 不需要迁移时回填历史标题。

不增加：

- 唯一索引。
- `source_storyline_id`。
- `copied_through_chapter`。
- 幂等 request ID。

### Migration

生成新的 Drizzle migration：

```sql
ALTER TABLE `storyline` ADD `title` text;
```

迁移后旧数据保持 `NULL`。

### 标题解析

新增可复用纯函数模块：

```text
packages/server/src/storyline/storyline-title.ts
```

接口建议：

```ts
export function deriveStorylineTitle(initialText: string): string;

export function resolveStorylineTitle(input: {
  explicitTitle: string | null;
  initialText: string;
}): string;
```

规则：

- `explicitTitle` 非空时 trim 后直接使用。
- 否则沿用现有“初始正文第一条非空行 + 最长 80 字”规则。
- 输出必须通过 `StorylineTitleSchema`。
- 列表和快照必须调用同一函数，不能产生两个标题规则。

`StorylineService.listStorylines`：

- 将 `storyline.title` 传给 list item mapper。
- 继续读取初始分段，用于 null fallback。

`StorylineService.getSnapshotByInternalId`：

- 查询故事行时取得显式标题。
- 同时读取初始分段正文，或调用共享的内部查询。
- 返回 `title: resolveStorylineTitle(...)`。

普通 `saveCreatedStoryline*` 不写 `title`，继续保持 null fallback。复制服务写入用户提交的显式标题。

## 服务职责

新增：

```text
packages/server/src/storyline/storyline-copy.service.ts
```

依赖：

```ts
constructor(
  private readonly databaseService: DatabaseService,
  private readonly lockService: StorylineLockService,
  private readonly storylineService: StorylineService,
) {}
```

公开接口：

```ts
async copyStoryline(input: {
  readonly body: unknown;
  readonly sourceStorylineId: string;
  readonly userId: string;
}): Promise<CopyStorylineResponse>;
```

`StorylineModule` 注册 `StorylineCopyService` provider。除非其他模块需要，不导出该 service。

## 请求处理顺序

### 1. 解析请求

使用 `CopyStorylineRequestSchema.safeParse(body)`：

- 得到已 trim 的标题。
- 拒绝额外字段。
- 拒绝非整数或非正数 N。

### 2. 验证故事归属

在获取锁前调用：

```ts
storylineService.getStorylineForUser(userId, sourceStorylineId);
```

找不到时抛出 `StorylineNotFoundError`。

先验证归属可以避免未授权用户通过锁冲突判断其他用户故事是否正在运行。

### 3. 获取故事锁

```ts
const releaseLock = lockService.acquireStorylineLock(
  sourceStoryline.externalId,
);
```

锁覆盖：

- 数据库复制事务。
- 新故事快照读取。
- 错误处理结束。

必须在 `finally` 中释放。

源故事上的生成、重写、互动、上下文提取和另一次复制都会使用同一个 key。

### 4. 事务内再次校验

获取锁后，在事务内再次校验：

- 源故事存在。
- `user_id` 属于当前用户。
- 源故事至少有一个分段。

这样可以避免锁前读取和事务读取之间的状态变化。

## 复制事务

### 读取源数据

在同一事务中读取：

- 源 `storyline`。
- 源故事全部 `storyline_segment`，按 `order_index` 升序。
- 源 `storyline_context`，如果存在。

当前项目是本地 SQLite 玩具项目，故事分段规模有限。首版可以读取整条故事后在内存中确定前缀和上下文截面，优先保证逻辑清晰。

### 校验章节

以最后分段的 `chapterIndex` 作为源故事章节数：

```ts
const sourceChapterCount = latestSegment.chapterIndex;
```

要求：

```text
1 <= throughChapter <= sourceChapterCount
```

复制分段：

```ts
const sourcePrefixSegments = sourceSegments.filter(
  (segment) => segment.chapterIndex <= throughChapter,
);
```

必须保证：

- 至少包含一个 initial 分段。
- 分段 `orderIndex` 保持严格递增。
- 前缀最后分段的 `chapterIndex === throughChapter`。

异常数据视为服务端数据损坏，不尝试静默修复。

### 创建新故事

```ts
const now = new Date();

insert(storylines).values({
  userId: internalUserId,
  title: request.title,
  createdAt: now,
  updatedAt: now,
});
```

不写来源字段。

### 第一阶段：复制分段主体

按 `orderIndex` 顺序逐条插入：

- `storylineId` 改为新故事 ID。
- `orderIndex` 原样保留。
- `chapterIndex` 原样保留。
- `type` 原样保留。
- `generationMode` 原样保留。
- `text` 原样保留。
- `instruction` 原样保留。
- `model` 原样保留。
- `elapsedMs` 原样保留。
- `inputTokens` 原样保留。
- `outputTokens` 原样保留。
- `totalTokens` 原样保留。
- `targetLength` 原样保留。
- `previousContextOrderIndex` 原样保留。
- `createdAt` 使用 `now`。
- `previousContextJson` 第一阶段暂时写 null。

每次 insert 读取新 ID，建立：

```ts
Map<sourceSegmentId, copiedSegmentId>;
```

采用逐条插入而不是假设批量 `returning()` 顺序，避免 ID 映射依赖驱动实现细节。

### 第二阶段：重写历史上下文

ID 映射完整后，遍历所有已复制 generated 分段：

1. 源 `previousContextJson === null` 时，副本保持 null。
2. 否则使用 `parseStoryContextJson` 解析。
3. 调用上下文分段 ID 重映射函数。
4. 使用 `serializeStoryContext` 校验并序列化。
5. update 对应副本分段的 `previous_context_json`。

两阶段写入发生在同一事务内，外部不会观察到临时 null 状态。

## 上下文截面选择

定义：

```ts
const cutoffOrderIndex = sourcePrefixSegments.at(-1)!.orderIndex;
```

目标是找到“不包含截止章节之后信息”的最新可靠上下文。该快照允许早于 N；本期优先保证不泄露未来状态，不要求构造数据库中不存在的“恰好截至 N”快照。

### 情况 A：源故事没有当前上下文

```text
sourceContextRow === undefined
```

副本不创建 `storyline_context`。所有已复制 generated 分段后续都处于待提取状态。

### 情况 B：当前上下文游标没有超过截止位置

```text
sourceContextRow.extractedThroughOrderIndex <= cutoffOrderIndex
```

使用源 `storyline_context.contextJson`，并保留：

```text
extractedThroughOrderIndex
```

这包括上下文提取进度落后于 N 的情况。副本创建后可以从同一游标继续处理其余已复制分段。

如果游标为 0，则不创建副本 context row，保持“尚无已提取上下文”的现有语义。

### 情况 C：当前上下文已经超过截止位置

```text
sourceContextRow.extractedThroughOrderIndex > cutoffOrderIndex
```

不能使用当前 `contextJson`，因为它可能包含第 N 章之后的信息。

查找第一个未复制 generated 分段：

```ts
const firstExcludedSegment = sourceSegments.find(
  (segment) =>
    segment.orderIndex > cutoffOrderIndex && segment.type === "generated",
);
```

该分段的：

- `previousContextJson` 表示它生成前的上下文。
- `previousContextOrderIndex` 表示该上下文提取到的位置。

选择规则：

- `previousContextOrderIndex` 为 0 或 `previousContextJson` 为 null：副本不创建当前上下文行。
- 否则使用该快照及游标。
- 游标必须 `<= cutoffOrderIndex`，否则视为数据损坏并回滚。

由于复制包含 `chapterIndex <= N` 的全部互动分段，第一个排除分段正常情况下是第 N+1 章的 append 分段，其生成前快照正好是可用于回退的前缀状态。

### 不允许的方案

- 不能直接复制源故事最新 `storyline_context`。
- 不能按 JSON 字符串替换数字 ID。
- 不能清空上下文后假装副本与原故事状态等价。
- 不能在复制过程中调用 LLM 重建上下文。

## 上下文 ID 重映射

新增纯函数模块：

```text
packages/server/src/storyline/storyline-context-remap.ts
```

接口：

```ts
export function remapStoryContextSegmentIds(input: {
  readonly context: StoryContextSnapshot;
  readonly segmentIdMap: ReadonlyMap<string, string>;
}): StoryContextSnapshot;
```

必须显式遍历以下字段：

```text
worldFacts[].sourceSegmentIds
characters[].sourceSegmentIds
characters[].relationships[].sourceSegmentIds
characters[].beliefs[].sourceSegmentIds
characters[].opinions[].sourceSegmentIds
currentScene.sourceSegmentIds
```

以下 ID 不重写：

- `fact_*`
- `char_*`
- `targetCharacterId`
- `factIds`
- `presentCharacterIds`
- `observableFactIds`

它们是故事上下文内部标识，不是数据库分段 ID。副本完整复制同一上下文时可以保持不变。

重映射规则：

```ts
function remapSourceSegmentIds(
  sourceIds: readonly string[],
  idMap: ReadonlyMap<string, string>,
): string[] {
  return sourceIds.map((sourceId) => {
    const copiedId = idMap.get(sourceId);
    if (copiedId === undefined) {
      throw new StorylineCopyFailedError(
        `Story context references a segment outside the copied prefix`,
      );
    }
    return copiedId;
  });
}
```

错误日志不能包含正文或完整上下文 JSON。可以记录源故事 ID、N 和缺失引用数量，但不记录上下文内容。

重映射结果必须再次通过 `StoryContextSnapshotSchema` 或 `serializeStoryContext`。

## 保存当前上下文

选出前缀上下文并完成重映射后：

```ts
insert(storylineContexts).values({
  storylineId: copiedStorylineId,
  contextJson: serializeStoryContext(remappedContext),
  extractedThroughOrderIndex,
  createdAt: now,
  updatedAt: now,
});
```

必须满足：

```text
0 < extractedThroughOrderIndex <= cutoffOrderIndex
```

若选定状态表示“没有已提取上下文”，则不插入空 context row，保持现有 `contextWasMissing` 语义。

## 事务结果

事务返回：

```ts
{
  copiedStorylineId: number;
  copiedSegmentCount: number;
  throughChapter: number;
}
```

提交后调用现有：

```ts
storylineService.getStorylineSnapshotForUser(
  userId,
  String(copiedStorylineId),
  {
    anchorPage: "latest",
    before: STORYLINE_CHAPTER_CACHE_RADIUS,
    after: 0,
  },
);
```

找不到快照视为保存失败。

返回：

```ts
{
  storyline: snapshot,
}
```

## 错误类型

新增：

```ts
export class StorylineCopyChapterOutOfRangeError extends Error {}
export class StorylineCopyFailedError extends Error {}
```

使用原则：

- 请求 schema 错误：`BadRequestException`。
- N 超出动态范围：`StorylineCopyChapterOutOfRangeError`，映射 `400`。
- 无权访问或源故事不存在：`StorylineNotFoundError`，映射 `404`。
- 故事锁冲突：`StorylineBusyError`，映射 `409`。
- 数据库、上下文解析、缺失 ID 映射：包装为 `StorylineCopyFailedError`，返回 `500`。

事务内已经识别的领域错误不能被统一包装成 500。

## 并发

### 单进程

当前 `StorylineLockService` 是进程内锁，能够阻止同一服务进程中的：

- append
- rewrite
- dialogue
- context extraction
- copy

对同一源故事并发运行。

### 多进程限制

项目当前以单个 PM2 服务进程为默认约定。若未来启用 PM2 cluster 或多实例部署，内存锁无法跨进程生效，需要升级为数据库锁、Redis 锁或带版本条件的事务。

本期不扩展分布式锁，但技术风险必须记录。

### 锁与数据库事务

- 先验证用户归属。
- 再获取源故事锁。
- 再开始 SQLite 事务。
- 先提交或回滚事务。
- 读取新故事快照。
- 最后释放锁。

不在持有数据库事务期间执行网络请求或 LLM 调用。

## 安全

- 所有接口使用 `JwtAuthGuard`。
- 源故事查询同时匹配 `storyline.id` 和 `user_id`。
- 新故事 `user_id` 强制使用当前认证用户，不接受 body 传入。
- title 由 Zod 限制长度，按普通文本处理。
- 服务端不把标题作为 SQL 片段或文件名。
- 不向 404 响应暴露故事是否属于其他用户。
- 结构化日志不记录标题全文、正文、指令或上下文 JSON。

## 性能

复制的时间复杂度为：

```text
O(源故事分段数 + 已复制上下文引用数)
```

首版读取源故事全部分段，是为了在上下文已经超过 N 时找到第一个排除分段及其历史快照。

SQLite 本地事务下，常规故事规模无需异步任务。若未来单故事分段达到数万级，可优化为：

- 查询 `chapter_index <= N` 的前缀。
- 单独查询第一个 `chapter_index > N` 的分段。
- 单独查询最后分段以取得总章节数。

该优化不改变 API。

## 日志

成功日志：

```json
{
  "event": "storyline_copy_completed",
  "sourceStorylineId": "10",
  "copiedStorylineId": "42",
  "throughChapter": 6,
  "copiedSegmentCount": 9,
  "userId": "3"
}
```

失败或冲突日志可以记录：

- event
- sourceStorylineId
- throughChapter
- userId
- error class

不得记录：

- 故事标题全文
- 正文
- 生成指令
- context JSON
- reasoning content

## 测试方案

### 上下文重映射单元测试

为 `storyline-context-remap.ts` 增加独立 spec：

- 重映射 world fact 来源。
- 重映射角色自身来源。
- 重映射 relationship、belief、opinion 来源。
- 重映射 current scene 来源。
- 保持 character ID 和 fact ID 不变。
- 遇到未复制 segment ID 时抛错。
- 输入对象不被原地修改。

### StorylineCopyService 单元测试

基础：

- N=1，只复制 initial 分段。
- N=总章节数，复制完整故事。
- 中间 N，只复制前缀。
- 第 N 章多个 dialogue 分段全部复制。
- 新故事 ID 和所有分段 ID 与源故事不同。
- `orderIndex` 和 `chapterIndex` 保持不变。
- 标题写入新故事，源故事标题不变。
- 相同标题允许创建多个副本。
- 副本可以再次复制。

生成记录：

- instruction、generationMode、model、elapsedMs、Token、targetLength 全部保留。
- latestGeneration 使用副本最后生成分段的新 ID。
- N=1 时 latestGeneration 为 null。

历史上下文：

- 每个 `previousContextJson` 的 sourceSegmentIds 都映射到副本。
- null previous context 保持 null。
- 重写副本最后分段能读取合法 previous context。

当前上下文：

- 源无 context 时副本无 context。
- 源 cursor 小于 cutoff 时复制当前 context 和 cursor。
- 源 cursor 等于 cutoff 时复制当前 context 和 cursor。
- 源 cursor 大于 cutoff 时使用第一个排除分段的 previous context。
- 回退快照 cursor=0 时副本不创建 context row。
- 副本 context 不包含任何未复制分段 ID。
- cursor 落后于 N 时 pendingRoundCount 计算正确。

失败与事务：

- N=0 在 schema 层返回 400。
- N 大于源章节数返回 400。
- 源故事不存在返回 404。
- 复制其他用户故事返回 404。
- 锁被占用时返回 409。
- 上下文引用未复制分段时整体回滚。
- 分段插入中途失败时整体回滚。
- 失败后不存在空 storyline。
- 锁在成功和异常路径都释放。

### Controller / E2E

- 带有效 token 创建副本返回 201。
- 响应通过 `CopyStorylineResponseSchema`。
- 新故事出现在列表顶部并显示显式标题。
- GET 新故事返回 title 和正确 chapterCount。
- GET 原故事内容、更新时间和标题不变。
- 无 token 返回 401。
- 非法 body 返回 400。
- 无权访问返回 404。
- 忙碌返回 409。

### 回归

- 普通创建故事仍然保存成功。
- 普通故事列表标题仍从初始正文派生。
- 旧数据 `storyline.title = null` 时列表和详情都返回合法标题。
- append / rewrite / dialogue 完成事件都包含 title。
- 章节窗口缓存逻辑不因 title 字段变化丢失标题。
- 上下文提取、重写回退和调试接口行为不变。

## 文件改动建议

```text
packages/schema/src/index.ts
  - StorylineTitleSchema
  - StorylineSnapshot.title
  - CopyStorylineRequest/Response

packages/server/src/database/schema/storylines.schema.ts
  - storyline.title nullable

packages/server/drizzle/<new-migration>.sql
  - ALTER TABLE storyline ADD title

packages/server/src/storyline/storyline-title.ts
  - 标题派生与显式标题 fallback

packages/server/src/storyline/storyline-context-remap.ts
  - 上下文 sourceSegmentIds 重映射

packages/server/src/storyline/storyline-copy.service.ts
  - 锁、事务和复制编排

packages/server/src/storyline/storyline.errors.ts
  - 复制范围和复制失败错误

packages/server/src/storyline/storyline.controller.ts
  - POST :storylineId/copies

packages/server/src/storyline/storyline.module.ts
  - 注册 StorylineCopyService

packages/server/src/storyline/storyline.service.ts
  - 快照和列表统一返回 title

packages/server/src/storyline/*.spec.ts
packages/server/test/realtime.e2e-spec.ts
  - 新增复制测试并更新 snapshot fixture
```

## 实施顺序

1. 增加共享标题、请求和响应 schema。
2. 增加 `storyline.title` migration。
3. 抽取统一标题解析函数，更新列表和快照。
4. 实现上下文 ID 重映射纯函数及单测。
5. 实现 `StorylineCopyService` 事务和锁。
6. 增加 Controller 路由和错误映射。
7. 增加 service 单测与 E2E。
8. 接入前端后执行全仓构建、lint、单测和 E2E。

## 验证命令

```bash
pnpm --filter @kimiko/schema typecheck
pnpm --filter @kimiko/server typecheck
pnpm --filter @kimiko/server lint
pnpm --filter @kimiko/server test
pnpm --filter @kimiko/server test:e2e
pnpm build
```

## 风险

### 上下文泄露到截止章节之后

风险最高。若错误复制源故事最新 context，副本续写会知道尚未发生的剧情。

控制：

- 按 cursor 与 cutoff 比较选择上下文。
- cursor 超过 cutoff 时只使用第一个排除分段的 previous context。
- 针对 ahead-of-cutoff 建立独立测试。

### 分段 ID 没有完整重映射

会导致上下文来源指向原故事，重写和调试数据失真。

控制：

- 使用结构化遍历，不做字符串替换。
- 任一 ID 缺失直接回滚。
- previous context 和 current context 使用同一个重映射函数。

### 非幂等重试

客户端超时后重试可能产生多个副本。

控制：

- 前端请求期间禁用提交。
- 文档明确本期限制。
- 后续如出现真实需求，再增加 request ID 和数据库唯一约束。

### 进程内锁

多实例部署时无法阻止跨进程并发。

控制：

- 本期保持单实例运行约定。
- 启用 PM2 cluster 前必须先升级锁实现。
