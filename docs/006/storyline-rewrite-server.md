# 为故事线添加重写功能服务端技术方案

## 背景

本文档对应 PRD：[storyline-rewrite.md](./storyline-rewrite.md) 和前端技术方案：[storyline-rewrite-fe.md](./storyline-rewrite-fe.md)。

本期目标是在服务端支持对最新 generated segment 的重写：客户端通过 WebSocket `story.continue` 发送 `mode: "rewrite"` payload；服务端校验目标段可重写后，基于生成前角色摘要、目标段之前的历史、目标段原正文和用户重写指令调用 Writer；正文生成完成后发送 `story.summary.started`；摘要基于目标段保存的 previousSummary 和新正文重新生成；最后在同一事务内原地更新目标段、更新当前角色摘要和故事线更新时间。

重写成功后不新增 segment，不保留版本历史，不产生分支故事线。重写失败、取消或断连时，旧正文和旧角色摘要都保持不变。

## IDL 结论

已读取前端技术方案 [storyline-rewrite-fe.md](./storyline-rewrite-fe.md) 中的 IDL Schema。本服务端技术方案沿用前端技术方案中的 IDL，不需要修改，因此不额外输出 `storyline-rewrite-fe-idl-change.md`。

服务端需要在 `packages/schema/src/index.ts` 中实现并使用前端技术方案定义的契约：

- 新增 `StoryContinueRewritePayloadSchema`。
- 新增 `StoryContinueRewritePayload` 类型。
- `StoryContinuePayloadSchema` union 增加 rewrite 分支。
- `StoryRealtimeErrorCodeSchema` 增加 `STORY_SEGMENT_NOT_REWRITABLE`。

重写请求结构：

```ts
{
  mode: "rewrite";
  storylineId: StorylineId;
  segmentId: StorylineSegmentId;
  instruction: string;
}
```

`story.completed` 不新增字段。重写成功后仍返回完整 `CompletedStorylineSnapshot`，`generatedSegmentId` 指向被原地替换的目标 generated segment。

事件顺序继续沿用：

```text
story.started
-> story.chunk*
-> story.summary.started
-> story.completed | story.cancelled | story.error
```

## 已确认决策

- 本期只支持重写最新 generated segment。
- 本期不支持重写 initial segment。
- 本期不支持重写任意历史 generated segment。
- 本期不保留重写版本历史，不支持回滚或分支故事线。
- 重写使用 `story.continue` 的 `mode: "rewrite"` 分支，不新增 WebSocket 消息类型。
- `story.completed` 契约不变。
- 重写使用故事线级锁，和 append 互斥。
- 服务端必须校验目标 segment 属于当前用户的当前故事线。
- 服务端必须校验目标 segment 是该故事线最新 generated segment。
- 不可重写请求使用专用错误类 `StorySegmentNotRewritableError`。
- `StorySegmentNotRewritableError` 映射为 `STORY_SEGMENT_NOT_REWRITABLE`。
- 重写 Writer prompt 使用独立 Rewrite Context，不复用续写 prompt 语义。
- 重写 prompt 必须包含目标段原续写指令、目标段原生成正文和用户重写指令。
- 前端不传旧正文、previousSummary 或角色摘要。
- 每个 generated segment 保存生成前角色摘要快照 previousSummary。
- previousSummary 存在 `storyline_segment.previous_summary_json`。
- initial segment 的 `previous_summary_json` 为空。
- create 生成段的 `previous_summary_json` 保存空快照 JSON。
- append 生成段的 `previous_summary_json` 保存 append 开始前的当前角色摘要。
- rewrite 不修改目标段的 `previous_summary_json`。
- 重写摘要必须使用目标段保存的 previousSummary。
- 重写摘要 prompt 需要区分「本轮重写指令」，不能继续标成「本轮续写指令」。
- 如果目标 generated segment 的 `previous_summary_json` 缺失或解析失败，视为保存失败，不做空摘要降级。
- 本期不考虑旧数据兼容。
- 本期服务端验证要求只强制单元测试。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 Drizzle ORM + SQLite。
- 启动时 `DatabaseModule` 会执行 Drizzle migration。
- WebSocket 使用原生 `ws`，通过 Nest `@WebSocketGateway({ path: "/realtime" })` 暴露。
- WebSocket 鉴权使用查询参数 `accessToken`。
- `RealtimeGateway` 已维护连接级 `activeTask` 和 `AbortController`。
- 当前 WebSocket 客户端消息只有 `story.continue` 和 `story.cancel`。
- 当前 `StorylineGenerationService` 负责 create/append 编排。
- 当前 `StorylineLockService` 已提供用户级 create 锁和故事线级锁。
- 当前 `StoryService.streamContinueStoryFromContext` 负责流式续写 Writer 调用。
- 当前 `StorylineSummaryService.generateCharacterSummary` 负责非流式摘要 Extractor 调用。
- 当前 `StorylineService` 负责故事线查询、上下文构造、segment 保存和 summary 保存。
- 当前 `storyline_summary` 表只保存每条故事线的当前角色摘要。
- 当前 `StorylineSnapshot` 不包含 instruction、model 明细或角色摘要。

## 新增和调整文件

调整共享契约：

- `packages/schema/src/index.ts`
  - 新增 `StoryContinueRewritePayloadSchema`。
  - 新增 `StoryContinueRewritePayload`。
  - `StoryContinuePayloadSchema` 增加 rewrite 分支。
  - `StoryRealtimeErrorCodeSchema` 增加 `STORY_SEGMENT_NOT_REWRITABLE`。

调整服务端数据库：

- `packages/server/src/database/schema/storylines.schema.ts`
  - `storylineSegments` 增加 `previousSummaryJson` 字段，对应数据库列 `previous_summary_json`。
- `packages/server/drizzle/*`
  - 通过 `pnpm --filter @kimiko/server db:generate` 生成迁移。

调整服务端业务代码：

- `packages/server/src/storyline/storyline.errors.ts`
  - 新增 `StorySegmentNotRewritableError`。
- `packages/server/src/realtime/realtime.types.ts`
  - `RealtimeErrorCode` 增加 `STORY_SEGMENT_NOT_REWRITABLE`。
- `packages/server/src/realtime/realtime.gateway.ts`
  - `errorMessages` 增加 `STORY_SEGMENT_NOT_REWRITABLE`。
  - `mapStreamErrorCode` 将 `StorySegmentNotRewritableError` 映射为 `STORY_SEGMENT_NOT_REWRITABLE`。
- `packages/server/src/story/story.service.ts`
  - 新增 `StoryRewriteLlmContext` 类型。
  - 新增 `streamRewriteStoryFromContext` 方法。
  - 新增 rewrite prompt 构造函数和单元测试导出点。
- `packages/server/src/storyline/storyline.types.ts`
  - 新增 rewrite 上下文和保存输入类型。
- `packages/server/src/storyline/storyline.service.ts`
  - 保存 create/append generated segment 时写入 previousSummaryJson。
  - 新增重写上下文构造方法。
  - 新增目标段可重写校验。
  - 新增 previousSummaryJson 解析和序列化。
  - 新增原地更新 generated segment 和 summary 的事务方法。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - `streamContinueStoryline` 增加 rewrite 分支。
  - 新增 `streamRewriteStoryline` 编排。
- `packages/server/src/storyline/storyline-summary.types.ts`
  - 扩展 `GenerateCharacterSummaryInput`，支持区分指令标签或 operation。
- `packages/server/src/storyline/storyline-summary.service.ts`
  - 摘要 prompt 根据 operation 输出「本轮续写指令」或「本轮重写指令」。

测试新增或调整：

- `packages/server/src/story/story.service.spec.ts`
  - 覆盖 rewrite prompt 构造。
- `packages/server/src/storyline/storyline-summary.service.spec.ts`
  - 覆盖重写摘要 prompt 使用「本轮重写指令」。
- `packages/server/src/storyline/storyline-lock.service.spec.ts`
  - 锁实现无需变更；如有必要补充 append/rewrite 共享故事线锁的说明性测试。
- `packages/server/src/storyline/storyline.service.spec.ts`
  - 如当前缺少该文件，则新增，用于覆盖 previousSummaryJson 保存、可重写校验、原地替换事务。
- `packages/server/src/storyline/storyline-generation.service.spec.ts`
  - 如实现时新增该测试文件，覆盖 rewrite 编排、summaryStarted、失败/取消不保存、锁释放。

本期不强制新增 E2E。

## 数据库设计

### `storyline_segment.previous_summary_json`

在 `storyline_segment` 表上增加 nullable 文本列：

```ts
previousSummaryJson: text("previous_summary_json"),
```

规则：

- initial segment 的 `previous_summary_json` 为 `null`。
- generated segment 的 `previous_summary_json` 必须保存生成前角色摘要快照。
- create 的 generated segment 保存空角色摘要快照：

```json
{"characters":[]}
```

- append 的 generated segment 保存 append 开始前的当前角色摘要；如果故事线当前没有摘要，则保存空角色摘要快照。
- rewrite 不修改目标 generated segment 的 `previous_summary_json`。
- rewrite 读取目标段的 `previous_summary_json` 作为摘要重算的 previousSummary。
- 读取 generated segment 的 `previous_summary_json` 时，如果为空、不是合法 JSON 或不符合 `StoryCharacterSummarySnapshotSchema`，视为数据不满足模型，抛保存失败相关错误。

说明：

- 本期仍保留 `storyline_summary` 表作为每条故事线的当前角色摘要。
- `previous_summary_json` 是每个 generated segment 的生成前状态快照。
- 该字段不进入 `StorylineSnapshot`。
- 该字段不返回前端。
- 本期不考虑旧数据兼容，迁移可以按本地实验项目策略处理。

## 错误设计

新增错误类：

```ts
export class StorySegmentNotRewritableError extends Error {
  constructor(message = "Story segment is not rewritable") {
    super(message);
    this.name = "StorySegmentNotRewritableError";
  }
}
```

映射规则：

| 内部错误 | WebSocket 错误码 | message | retryable |
| --- | --- | --- | --- |
| `StorySegmentNotRewritableError` | `STORY_SEGMENT_NOT_REWRITABLE` | `当前段落不可重写` | `true` |
| `StorylineNotFoundError` | `STORYLINE_NOT_FOUND` | `故事线不存在` | `true` |
| `StorylineBusyError` | `STORYLINE_BUSY` | `当前故事线正在生成，请稍后重试` | `true` |
| `StorylineSaveFailedError` | `STORYLINE_SAVE_FAILED` | `保存失败，请稍后重试` | `true` |
| `StorySummaryFailedError` | `STORY_SUMMARY_FAILED` | `生成失败，请稍后重试` | `true` |

说明：

- segment 不属于该故事线、segment 不是 generated、segment 不是最新 generated，均使用 `StorySegmentNotRewritableError`。
- storyline 不存在或不属于当前用户，仍使用 `StorylineNotFoundError`。
- previousSummary 缺失或解析失败不是业务不可重写，而是服务端数据状态异常，使用 `StorylineSaveFailedError` 或内部保存失败路径。

## Writer 设计

### 续写 Context 保持不变

现有 `StoryLlmContext` 继续服务 create/append。

### 新增 Rewrite Context

新增独立类型：

```ts
export interface StoryRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInstruction: string;
  readonly originalGeneratedText: string;
  readonly initialStoryText?: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly historyRoundsBeforeTarget: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}
```

新增方法：

```ts
async *streamRewriteStoryFromContext(
  context: StoryRewriteLlmContext,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent>
```

说明：

- 该方法复用底层 `streamStoryLlmRequest`。
- 该方法不复用 `buildStoryUserPromptFromContext`。
- rewrite prompt 的目标是“生成替换目标段的新正文”，不是“继续向后写”。
- Writer 输出仍只允许正文，不允许解释、标题、列表或调试信息。

### Rewrite Prompt

重写 prompt 应包含：

```text
角色摘要：
<characterSummary JSON，可省略>

故事正文：
<initialStoryText，可因 history trim 省略>

目标段之前的近期续写轨迹：
第 N 轮指令：
...
第 N 轮续写：
...

原续写指令：
<originalInstruction>

原生成正文：
<originalGeneratedText>

重写指令：
<rewriteInstruction>
```

输出规则应明确：

- 只输出用于替换原生成正文的新正文。
- 不要输出初始故事正文。
- 不要输出原生成正文。
- 不要继续写目标段之后的新剧情。
- 新正文必须承接目标段之前的上下文。
- 新正文可以保留原生成正文中仍合理的部分，但必须优先服从重写指令。
- 不输出标题、解释、列表、调试信息或“以下是重写”等前缀。

## 重写上下文构造

在 `StorylineService` 中新增方法：

```ts
async buildRewriteLlmContext(input: {
  readonly userId: string;
  readonly storylineId: string;
  readonly segmentId: string;
  readonly rewriteInstruction: string;
  readonly historyRoundLimit: number;
}): Promise<StorylineRewriteContext>
```

推荐返回类型：

```ts
export interface StorylineRewriteContext {
  readonly storyline: StorylineRecord;
  readonly targetSegmentId: string;
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly writerContext: StoryRewriteLlmContext;
  readonly summaryHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
}
```

构造流程：

1. 解析并查询当前用户的 storyline。
2. 查询该 storyline 的全部 segments，按 `orderIndex` 升序。
3. 找到 initial segment；缺失则抛内部错误。
4. 找到目标 segment。
5. 校验目标 segment 属于当前 storyline。
6. 校验目标 segment 的 `type === "generated"`。
7. 找到最新 generated segment。
8. 校验目标 segment id 等于最新 generated segment id。
9. 解析目标 segment 的 `previous_summary_json`。
10. 构造目标段之前的 generated rounds。
11. 根据 `historyRoundLimit` 裁剪目标段之前的历史。
12. 构造 `StoryRewriteLlmContext`。
13. 返回 previousSummary 和摘要所需上下文。

历史裁剪规则：

- 重写仅支持最新 generated segment，因此“目标段之前的历史”就是当前 generated rounds 去掉最后一轮。
- 如果目标段之前的 generated rounds 超过 `historyRoundLimit`，只取最后 N 轮。
- 如果历史被裁剪，Writer prompt 可以省略 initialStoryText，并用“近期故事正文片段/近期指令轨迹”结构，保持和续写 prompt 的 token 控制策略一致。
- 摘要输入也只使用目标段之前裁剪后的近期历史。

## 摘要设计

### Summary Input 扩展

当前 `GenerateCharacterSummaryInput` 使用 `currentInstruction`，prompt 固定写「本轮续写指令」。本期需要区分 append 和 rewrite。

推荐扩展：

```ts
export type StorySummaryOperation = "append" | "rewrite";

export interface GenerateCharacterSummaryInput {
  readonly operation: StorySummaryOperation;
  readonly previousSummary: StoryCharacterSummarySnapshot | null;
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}
```

prompt 标签规则：

- `operation === "append"`：使用 `本轮续写指令：`。
- `operation === "rewrite"`：使用 `本轮重写指令：`。

create 可以按 append 处理，因为首轮生成仍是从初始正文继续生成。

### Rewrite Summary 输入

重写成功生成新正文后，调用：

```ts
await storylineSummaryService.generateCharacterSummary(
  {
    operation: "rewrite",
    previousSummary: rewriteContext.previousSummary,
    initialStoryText: rewriteContext.initialStoryText,
    recentHistoryRounds: rewriteContext.summaryHistoryRounds,
    currentInstruction: rewriteInstruction,
    generatedText: event.continuedStory,
  },
  options,
);
```

说明：

- `previousSummary` 必须来自目标 segment 的 `previous_summary_json`。
- 不允许使用当前 `storyline_summary` 表中的摘要作为 previousSummary。
- `generatedText` 是新重写正文，不是旧正文。
- summary 生成失败时，旧正文和旧 summary 均不修改。

## 保存事务

新增保存输入：

```ts
export interface SaveRewrittenSegmentWithSummaryInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly segmentId: string;
  readonly instruction: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly characterSummary: StoryCharacterSummarySnapshot;
}
```

新增方法：

```ts
async saveRewrittenSegmentWithSummary(
  input: SaveRewrittenSegmentWithSummaryInput,
): Promise<CompletedStorylineSnapshot>
```

事务内必须完成：

1. 校验 storyline 存在且属于当前用户。
2. 查询并校验目标 segment 存在。
3. 校验目标 segment 属于该 storyline。
4. 校验目标 segment 是 generated。
5. 校验目标 segment 是最新 generated segment。
6. 更新目标 segment：
   - `text`
   - `instruction`
   - `model`
   - `elapsedMs`
   - `inputTokens`
   - `outputTokens`
   - `totalTokens`
   - `createdAt` 是否更新见下方说明
7. upsert `storyline_summary` 当前摘要。
8. 更新 `storyline.updatedAt`。
9. 返回 `{ storylineId, generatedSegmentId: targetSegment.id }`。

关于 `createdAt`：

- 推荐不更新目标 segment 的 `createdAt`，因为 segment id 和顺序代表故事结构中的固定位置。
- 重写成功后的排序和列表上浮依赖 `storyline.updatedAt`。
- 如果后续需要展示“最近生成时间”，再单独增加字段，不在本期扩大范围。

事务外：

- 调用 `getCompletedSnapshot(savedIds)`。
- 因为目标段是最新 generated segment，`latestGeneration.segmentId` 应等于目标段 id。

不变性：

- 不新增 segment。
- 不改变 `orderIndex`。
- 不改变 `previous_summary_json`。
- 不改变 initial segment。
- 保存失败时事务回滚，旧正文和旧 summary 保持不变。

## 生成编排

`StorylineGenerationService.streamContinueStoryline` 增加 rewrite 分支：

```ts
if (input.payload.mode === "rewrite") {
  yield* this.streamRewriteStoryline(input, options);
  return;
}
```

`streamRewriteStoryline` 流程：

1. 校验 payload mode 为 rewrite。
2. 查询 storyline；不存在则抛 `StorylineNotFoundError`。
3. 获取故事线级锁。
4. 构造 rewrite 上下文。
5. 调用 `storyService.streamRewriteStoryFromContext()`。
6. 对 chunk 逐个 yield。
7. Writer completed 后 yield `{ type: "summaryStarted" }`。
8. 如果 signal aborted，直接 return。
9. 调用 `StorylineSummaryService.generateCharacterSummary()`，operation 为 rewrite。
10. 如果 signal aborted，直接 return。
11. 调用 `saveRewrittenSegmentWithSummary()` 原地保存。
12. yield completed 事件。
13. finally 释放锁。

取消规则：

- Writer 阶段取消：不保存。
- Summary 阶段取消：不保存。
- 保存前取消：不保存。
- WebSocket 断连触发 abort，语义同取消。

失败规则：

- Writer 失败：不保存。
- Summary 失败：不保存。
- 保存失败：事务回滚。
- 不可重写：不调用 Writer，不发送 chunk。

## previousSummary 写入规则

### Create

`saveCreatedStorylineWithSummary` 插入 generated segment 时，写入：

```ts
previousSummaryJson: serializeCharacterSummary(emptyCharacterSummarySnapshot)
```

当前 summary 表仍保存 Writer + Extractor 之后的新摘要。

### Append

append 开始时，`buildLlmContext` 已读取当前 summary。保存 appended generated segment 时，需要把 append 开始前的 summary 传入保存方法。

调整输入：

```ts
export interface SaveAppendedSegmentWithSummaryInput
  extends SaveAppendedSegmentInput {
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly characterSummary: StoryCharacterSummarySnapshot;
}
```

`StorylineGenerationService.streamAppendStoryline` 调用保存时：

```ts
previousSummary: context.characterSummary ?? emptyCharacterSummarySnapshot
```

插入 generated segment 时写入 `previousSummaryJson`。

### Rewrite

rewrite 保存时不修改 `previousSummaryJson`。

目标段的 previousSummary 代表“该段生成前的状态”，重写不会改变目标段之前的正式故事历史，所以该快照保持有效。

## 可重写校验

校验函数建议集中在 `StorylineService` 内，供 build context 和 save transaction 复用。

规则：

- `storylineId` 必须能解析为内部 id。
- `segmentId` 必须能解析为内部 id。
- storyline 必须存在且属于当前用户。
- segment 必须存在。
- segment.storylineId 必须等于 storyline.id。
- segment.type 必须为 generated。
- segment.id 必须等于当前最新 generated segment.id。

错误：

- storyline 不存在或不属于当前用户：`StorylineNotFoundError`。
- segment id 无法解析、segment 不存在、segment 不属于该故事线、segment 非 generated、segment 非最新 generated：`StorySegmentNotRewritableError`。

说明：

- segment 不存在不返回 `STORYLINE_NOT_FOUND`，因为前端语义是“目标段不可重写”。
- 该策略避免泄露跨故事线 segment 细节，同时满足前端错误码需求。

## 单元测试要求

本期服务端不强制新增 E2E，但必须补充单元测试覆盖核心风险。

### `story.service.spec.ts`

覆盖：

- `buildRewriteStoryLlmRequestFromContext` 包含角色摘要、初始故事正文、目标段之前历史、原续写指令、原生成正文、重写指令。
- rewrite prompt 使用「重写指令」标签。
- rewrite prompt 不使用「当前续写指令」作为最终任务标签。
- rewrite system/user prompt 要求只输出替换正文。
- 流式 rewrite 复用 chunk/completed 归一化逻辑。

### `storyline-summary.service.spec.ts`

覆盖：

- operation 为 append 时 prompt 写「本轮续写指令」。
- operation 为 rewrite 时 prompt 写「本轮重写指令」。
- rewrite summary input 中 previousSummary 会以旧角色摘要输出。
- JSON 解析和 schema 校验逻辑保持不变。

### `storyline.service.spec.ts`

如当前不存在该文件，则新增。覆盖：

- create 生成段写入空 previousSummary JSON。
- append 生成段写入 append 前当前 summary。
- build rewrite context 只允许最新 generated segment。
- initial segment 不可重写。
- 非最新 generated segment 不可重写。
- 跨故事线 segment 不可重写。
- previousSummaryJson 缺失或非法时失败，不降级为空摘要。
- save rewritten segment 原地更新目标段文本、指令和元数据。
- save rewritten segment 不改变 segmentCount。
- save rewritten segment 不改变 previousSummaryJson。
- save rewritten segment 更新 summary 和 storyline.updatedAt。
- save rewritten segment 失败时事务回滚。

### `storyline-generation.service.spec.ts`

如实现时新增该文件，覆盖：

- rewrite 分支使用故事线级锁。
- rewrite Writer chunk 会透传。
- Writer completed 后发送 summaryStarted。
- summary 成功后调用原地保存并返回 completed。
- summary 失败时不保存。
- signal aborted 时不保存并释放锁。
- 不可重写时不调用 Writer。

### `realtime.gateway` 相关单元测试

如果当前没有专门单测，可在现有测试组织中覆盖错误映射：

- `StorySegmentNotRewritableError` 映射为 `STORY_SEGMENT_NOT_REWRITABLE`。
- 错误 message 为 `当前段落不可重写`。

## 验证

本期服务端实现完成后至少执行：

```bash
pnpm --filter @kimiko/server test
```

推荐同时执行：

```bash
pnpm typecheck
pnpm lint
```

本期不强制新增或执行 E2E。若实现过程中发现 WebSocket 协议风险较高，再补充 rewrite 成功、非法段和摘要失败的 `realtime.e2e-spec.ts` 覆盖。

## 验收标准

- `StoryContinuePayloadSchema` 支持 `mode: "rewrite"`。
- `StoryRealtimeErrorCodeSchema` 支持 `STORY_SEGMENT_NOT_REWRITABLE`。
- rewrite 请求复用 `story.continue`。
- rewrite 成功事件顺序为 `story.started -> story.chunk* -> story.summary.started -> story.completed`。
- rewrite 成功后不新增 segment。
- rewrite 成功后目标 generated segment id 不变。
- rewrite 成功后目标 generated segment 文本、指令、模型和 token 元数据更新。
- rewrite 成功后 `storyline.updatedAt` 更新。
- rewrite 成功后 `storyline_summary` 更新为新正文提取出的摘要。
- rewrite 成功后 `previous_summary_json` 不变。
- create generated segment 保存空 previousSummary JSON。
- append generated segment 保存 append 前当前 summary。
- rewrite 摘要使用目标段 previousSummary，不使用当前 summary。
- rewrite prompt 包含原生成正文和重写指令。
- rewrite prompt 不要求模型继续写目标段之后的新剧情。
- initial segment 不可重写。
- 非最新 generated segment 不可重写。
- 跨故事线或跨用户 segment 不可重写。
- 不可重写错误映射为 `STORY_SEGMENT_NOT_REWRITABLE`。
- previousSummaryJson 缺失或非法时不做空摘要降级。
- Writer 失败、summary 失败、取消或保存失败时，旧正文和旧摘要保持不变。
