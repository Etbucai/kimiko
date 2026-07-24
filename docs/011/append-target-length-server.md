# 续写字数档位服务端技术方案

## 背景

本文档对应需求文档：[append-target-length.md](./append-target-length.md) 和前端方案：[append-target-length-fe.md](./append-target-length-fe.md)。

`011` 的产品目标是：在已有故事线的 `append` 续写场景中，允许用户提交本轮的目标字数。服务端需要完成三件事：

- 在故事线主链路中接收并强校验 `targetLength`。
- 把 `targetLength` 注入正文 Writer 的长度约束。
- 为未来 rewrite 一段 append 正文时保留原始长度倾向。

当前服务端的主要问题有两处：

- `append` 续写的长度要求硬编码在 `STORY_SYSTEM_PROMPT` 里，固定为 `800-1200 字`。
- `storyline_segment` 目前不保存本轮目标字数，因此未来 rewrite 某段 append 正文时，服务端无法知道这段正文当初是按短段还是长段生成的。

因此，本期服务端目标不只是“让 append 当次生成变长变短”，还要把它纳入正式生成元数据，以支撑后续 append rewrite 的长度继承。

## 已确认决策

- 新增独立服务端技术文档：`docs/011/append-target-length-server.md`。
- 本期服务端方案只覆盖当前故事线主链路：
  - `StoryContinueAppendPayload`
  - `RealtimeGateway`
  - `StorylineGenerationService`
  - `StorylineService`
  - `StoryService`
- 不以 011 为目标去改造旧的 `ContinueStoryRequest` 测试链路。
- `StoryContinueAppendPayload` 新增 `targetLength`，类型为整数，范围 `100-1200`。
- 服务端对 `100-1200` 开放区间做真实承诺：
  - 只要是合法整数，就直接按原值处理；
  - 不归一到前端四档；
  - 不拒绝 `333` 这类非四档值。
- Writer Prompt 使用近似语义，而不是严格命中语义：
  - 推荐表达：`输出目标长度约 X 字，允许在合理范围内浮动。`
- `targetLength` 需要正式持久化，以支持未来 append rewrite 继承。
- 持久化位置采用 `storyline_segment.target_length` 列。
- `target_length` 只对 append generated segment 有意义：
  - `initial` 为 `null`
  - `create` 首轮 generated 为 `null`
  - `dialogue` generated 为 `null`
  - append generated 保存真实值
- 当用户 rewrite 一段原本带有 `targetLength` 的 append 正文时，服务端继续继承原值。
- rewrite 更新该 segment 时，不覆盖、不清空 `target_length`。
- `targetLength` 同时写入结构化日志，便于排查“请求长度 vs 实际产出长度”的偏差。
- 本期不把 `targetLength` 暴露到 `StorylineSnapshot`、`StorylineListItem` 或前端 DTO。
- 本期不新增专用错误码，非法长度继续按现有 `INVALID_PAYLOAD` / schema 校验链路处理。

## 非目标

- 不为 `create` 新建故事新增长度选择能力。
- 不为 `dialogue` 新增长度选择能力。
- 不新增 rewrite 的独立长度输入字段。
- 不让前端按故事线查询历史 `targetLength`。
- 不把长度偏好保存到用户表或故事线表。
- 不因长度偏差自动截断正文。
- 不因长度偏差自动补写或重试。
- 不为旧 `ContinueStoryRequest` 独立补一套 `targetLength` 契约。

## 现有服务端约束

- 服务端使用 NestJS。
- 共享契约集中在 `@kimiko/schema`，使用 Zod 作为 SSOT。
- 实时故事生成通过 WebSocket `story.continue` 发起。
- `StoryContinuePayloadSchema` 当前包含：
  - `create`
  - `append`
  - `rewrite`
  - `dialogue`
- `append` 生成主链路当前为：

```text
RealtimeGateway
  -> StoryGenerationTaskService.start
  -> StorylineGenerationService.streamAppendStoryline
  -> StorylineService.buildLlmContext
  -> StoryService.streamContinueStoryFromContext
  -> StorylineContextService.generateStoryContextPatch
  -> StorylineService.saveAppendedSegmentWithContext
```

- 正文 Writer Prompt 位于 `packages/server/src/story/story.service.ts`。
- 当前 `STORY_SYSTEM_PROMPT` 固定包含：`输出目标长度为 800-1200 字。`
- 当前 `storyline_segment` 已承载大部分生成元数据：
  - `instruction`
  - `model`
  - `elapsed_ms`
  - `input_tokens / output_tokens / total_tokens`
  - `previous_context_json`
- `storyline_segment` 当前没有 `target_length`。
- `saveRewrittenSegmentWithContext` 更新 target segment 时，只覆盖正文和元数据，不改 `generationMode`。

## 设计总览

011 的服务端改动分成四层：

```text
共享契约
  - append payload 新增 targetLength

数据库
  - storyline_segment 新增 nullable target_length

Writer 上下文与 Prompt
  - append 当次生成使用 targetLength
  - append rewrite 继承 targetLength
  - prompt 采用“约 X 字，允许合理浮动”

编排与日志
  - append 保存 targetLength
  - rewrite 保留已有 targetLength
  - gateway / generation log 补 targetLength
```

核心原则：

1. 用户可配置长度只发生在 append。
2. 服务端主契约接受开放整数区间，不偷偷改写客户端输入。
3. 服务端为了 rewrite 一致性，需要把 append 的 `targetLength` 变成正式 segment 元数据。

## 共享契约

在 `packages/schema/src/index.ts` 中扩展：

```ts
export const StoryContinueAppendPayloadSchema = z
  .object({
    mode: z.literal("append"),
    storylineId: StorylineIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
    targetLength: z.number().int().min(100).max(1_200),
  })
  .strict();
```

说明：

- `targetLength` 必填。
- 只接受整数。
- 合法范围是 `100-1200`。
- 前端本期只会发 `250 | 500 | 750 | 1000`，但服务端不依赖这一前提。

`StoryContinuePayloadSchema` 仍然保持 discriminated union 结构，只是 append 分支扩展字段。

其他 mode 不变：

- `create` 不新增 `targetLength`
- `rewrite` 不新增 `targetLength`
- `dialogue` 不新增 `targetLength`

## 数据库设计

### `storyline_segment.target_length`

在 `packages/server/src/database/schema/storylines.schema.ts` 的 `storylineSegments` 中新增：

```ts
targetLength: integer("target_length"),
```

语义：

- 该列表示“这条 generated segment 的原始目标字数”。
- 本期只对 `generationMode: "append"` 的 generated segment 有意义。

推荐存储规则：

| segment 类型        | generationMode | targetLength        |
| ------------------- | -------------- | ------------------- |
| initial             | append 默认值  | `null`              |
| generated(create)   | append         | `null`              |
| generated(append)   | append         | 本轮 `targetLength` |
| generated(dialogue) | dialogue       | `null`              |

### 迁移

新增一个新的 drizzle migration，例如：

- `packages/server/drizzle/0007_<name>.sql`

迁移内容：

```sql
ALTER TABLE `storyline_segment` ADD `target_length` integer;
```

因为本项目是本地实验项目，可以接受：

- 历史 append rows 的 `target_length` 为 `null`
- 不为历史数据做复杂回填

### 历史数据回退规则

如果用户未来 rewrite 到一条历史 append segment，而该行的 `target_length` 为 `null`，则服务端回退到旧默认长度策略，也就是当前 `800-1200 字` 的默认提示词。

这保证：

- 新数据享受精确继承
- 旧数据不阻塞 rewrite

## Writer Prompt 设计

### 新增动态 System Prompt helper

当前 `STORY_SYSTEM_PROMPT` 是固定常量，不适合承载每次 append 不同的长度要求。

建议在 `packages/server/src/story/story.service.ts` 中新增：

```ts
export function buildStorySystemPrompt(targetLength?: number): string;
```

规则：

- 当 `targetLength === undefined` 时，保持旧语义：

```text
输出目标长度为 800-1200 字。
```

- 当 `targetLength` 是合法整数时，使用新语义：

```text
输出目标长度约 500 字，允许在合理范围内浮动。
```

### 为什么放在 system prompt

推荐把长度约束放在 system prompt，而不是 user prompt，原因有三点：

1. 它属于 Writer 的输出规则，而不是故事内容本身。
2. 当前固定长度要求本来就在 system prompt，沿用现有职责划分最自然。
3. rewrite 继承原长度时，也更适合把它视为 Writer 策略而非用户内容。

### Dialogue Prompt 不变

`STORY_DIALOGUE_SYSTEM_PROMPT` 保持不变。

本期不对 dialogue 引入 `targetLength` 概念。

## StoryService 设计

### `StoryLlmContext`

建议扩展：

```ts
export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly targetLength?: number;
  readonly contextBundle: StoryWriterContextBundle;
}
```

说明：

- `create` 路径不传该字段。
- `append` 路径传入本轮 `targetLength`。
- 使用可选字段，而不是拆一个 append 专属 context，可以减少当前代码侵入面。

### `StoryRewriteLlmContext`

建议扩展：

```ts
export interface StoryRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInstruction: string;
  readonly originalGeneratedText: string;
  readonly initialStoryText?: string;
  readonly targetLength?: number;
  readonly contextBundle: StoryWriterContextBundle;
}
```

说明：

- 只有 rewrite append segment 时才可能有值。
- rewrite dialogue segment 不使用该字段。

### Prompt builder 调整

建议调整：

- `buildStoryLlmRequestFromContext(context)` 使用 `buildStorySystemPrompt(context.targetLength)`
- `buildRewriteStoryLlmRequestFromContext(context)` 使用 `buildStorySystemPrompt(context.targetLength)`

不需要改：

- `buildDialogueStoryLlmRequestFromContext`
- `buildRewriteDialogueLlmRequestFromContext`

### 旧链路策略

`buildStoryLlmRequest(request: ContinueStoryRequest)` 和 `streamContinueStory(body)` 不属于 011 主目标。

实现上可以二选一：

1. 保持原样，继续使用固定 `STORY_SYSTEM_PROMPT`
2. 复用 `buildStorySystemPrompt(undefined)`，但保证行为与旧常量完全一致

文档推荐只要求“行为不变”，不把这条旧链路纳入 011 验收范围。

## StorylineService 设计

### `buildLlmContext`

当前签名：

```ts
async buildLlmContext(input: {
  readonly userId: string;
  readonly storylineId: string;
  readonly currentInstruction: string;
  readonly historyScoreConfig: HistoryScoreConfig;
}): Promise<StoryLlmContext>
```

建议扩展：

```ts
readonly targetLength: number;
```

返回的 `StoryLlmContext` 中带上：

```ts
targetLength: input.targetLength;
```

说明：

- 只在 append 生成时调用该版本。
- create 生成仍然手工构造 `StoryLlmContext`，不需要传 `targetLength`。

### `buildRewriteLlmContext`

当前实现会读取 `targetSegment`、`previousContext` 和原始 `instruction`。

本期新增逻辑：

- 当 `targetGenerationMode === "append"` 时：
  - 读取 `targetSegment.targetLength`
  - 若为有效整数，则透传到 `StoryRewriteLlmContext.targetLength`
  - 若为 `null`，则不传，回退到默认长度策略

示意：

```ts
const targetLength = getNullableNumber(targetSegment.targetLength);

const writerContext: StoryRewriteLlmContext = {
  rewriteInstruction: input.rewriteInstruction,
  originalInstruction: ...,
  originalGeneratedText: ...,
  ...(targetLength === null ? {} : { targetLength }),
  contextBundle,
};
```

### 保存 append segment

扩展 `SaveAppendedSegmentInput` 和 `SaveAppendedSegmentWithContextInput`：

```ts
readonly targetLength: number;
```

`saveAppendedSegmentWithContext` 在 insert generated segment 时写入：

```ts
targetLength: input.targetLength,
```

### 保存 rewrite segment

`saveRewrittenSegmentWithContext` 不新增 `targetLength` 入参。

原因：

- rewrite 没有新的长度输入字段。
- 本期要求继承原 segment 的 `targetLength`。
- 因此 update 语句中不设置 `targetLength`，即可保留原值。

这点要在文档里显式写清，避免后续有人为了“字段完整”而在 rewrite 时意外清空该列。

### DTO 映射

`mapSegmentDto`、`mapListItemDto`、`mapGenerationMetadata` 都不需要暴露 `targetLength`。

本期服务端把它视为内部生成元数据，而不是前端消费字段。

## StorylineGenerationService 设计

### append 编排

`streamAppendStoryline` 的关键调整有两处。

#### 构建 LLM context

当前：

```ts
const context = await this.storylineService.buildLlmContext({
  userId: input.userId,
  storylineId: storyline.externalId,
  currentInstruction: input.payload.instruction,
  historyScoreConfig: getHistoryScoreConfig(),
});
```

调整后：

```ts
const context = await this.storylineService.buildLlmContext({
  userId: input.userId,
  storylineId: storyline.externalId,
  currentInstruction: input.payload.instruction,
  targetLength: input.payload.targetLength,
  historyScoreConfig: getHistoryScoreConfig(),
});
```

#### 保存 append segment

当前：

```ts
await this.storylineService.saveAppendedSegmentWithContext({
  userId: input.userId,
  storylineId: storyline.externalId,
  instruction: input.payload.instruction,
  generatedText: event.continuedStory,
  model: event.model,
  elapsedMs: event.elapsedMs,
  usage: event.usage,
  previousContext,
  contextPatch,
});
```

调整后增加：

```ts
targetLength: input.payload.targetLength,
```

### rewrite 编排

`streamRewriteStoryline` 不新增对外 payload 字段。

但当目标段是 append segment 时，`buildRewriteLlmContext()` 会把持久化的 `targetLength` 填回 `writerContext`，从而让 rewrite append 使用和原段一致的长度倾向。

也就是说：

- rewrite append：内部继承原段 `targetLength`
- rewrite dialogue：完全不受影响

### create / dialogue 编排

不需要接入 `targetLength`。

## RealtimeGateway 与日志

### WebSocket 契约

不新增新消息类型。

`story.continue` 的 append payload 只是新增一个字段：

```json
{
  "type": "story.continue",
  "requestId": "request-append",
  "payload": {
    "mode": "append",
    "storylineId": "123",
    "instruction": "继续写",
    "targetLength": 500
  }
}
```

### Gateway 日志

建议在 `RealtimeGateway.handleRawMessage` 的 `story_realtime_message_received` 日志中，append 场景补充：

```ts
targetLength: parsedMessage.message.type === "story.continue" &&
parsedMessage.message.payload.mode === "append"
  ? parsedMessage.message.payload.targetLength
  : undefined;
```

### Generation phase 日志

建议在 `StorylineGenerationService.logGenerationPhase()` 的结构化日志字段中新增：

```ts
targetLength?: number;
```

推荐覆盖：

- append 的 `request_received`
- append 的 `llm_context_build_started/completed`
- append 的 `writer_stream_started`
- append 的 `writer_completed`
- append 的 `save_completed`
- rewrite append 的 `llm_context_build_completed`
- rewrite append 的 `writer_completed`

这样后续排查时可以直接对照：

- 请求的 `targetLength`
- 实际 `generatedTextChars`
- 最终保存是否成功

## 兼容与回退策略

### 非前端官方客户端

如果别的客户端发送：

```json
{
  "mode": "append",
  "targetLength": 333
}
```

只要通过 schema 校验，服务端就按 `333` 原样进入 prompt。

不做：

- 向 `250`
- 向 `500`
- 任何最近档位归一化

### 历史数据 rewrite

对于 011 之前已经存在的 append segment：

- `target_length` 会是 `null`
- rewrite 这类旧 segment 时，Writer 回退到默认长度策略

### 前端 DTO

本期不返回 `targetLength` 给前端，因此不会引入：

- `StorylineSnapshot` 变更
- `StorylineListItem` 变更
- `StorylineGenerationMetadata` 变更

## 涉及文件

### 共享契约

- `packages/schema/src/index.ts`

### 数据库

- `packages/server/src/database/schema/storylines.schema.ts`
- `packages/server/drizzle/0007_<name>.sql`
- `packages/server/drizzle/meta/*`

### Story Writer

- `packages/server/src/story/story.service.ts`
- `packages/server/src/story/story.service.spec.ts`

### Storyline 编排与持久化

- `packages/server/src/storyline/storyline.types.ts`
- `packages/server/src/storyline/storyline.service.ts`
- `packages/server/src/storyline/storyline.service.spec.ts`
- `packages/server/src/storyline/storyline-generation.service.ts`
- `packages/server/src/storyline/storyline-generation.service.spec.ts`

### Realtime

- `packages/server/src/realtime/realtime.gateway.ts`
- `packages/server/test/realtime.e2e-spec.ts`

## 测试建议

### 单元测试

#### `story.service.spec.ts`

- append context 带 `targetLength` 时，system prompt 包含：
  - `输出目标长度约 500 字`
  - `允许在合理范围内浮动`
- append rewrite context 带 `targetLength` 时，rewrite prompt 也包含相同语义
- dialogue / dialogue rewrite prompt 不受影响
- `targetLength === undefined` 时，仍回退到旧默认长度规则

#### `storyline.service.spec.ts`

- append 保存时，`storyline_segment.target_length` 正确写入
- create generated 保存时，`target_length === null`
- dialogue 保存时，`target_length === null`
- rewrite append segment 时，不改写既有 `target_length`
- rewrite 历史旧 segment（`target_length === null`）时，context builder 正常回退

#### `storyline-generation.service.spec.ts`

- append 编排会把 `input.payload.targetLength` 传给 `buildLlmContext`
- append 保存会把 `targetLength` 传给 `saveAppendedSegmentWithContext`
- rewrite append 时，如果 `buildRewriteLlmContext` 返回带 `targetLength` 的 writerContext，则会进入对应 prompt 构造链路

### E2E

#### `realtime.e2e-spec.ts`

- append websocket payload 带 `targetLength` 能成功生成
- provider 收到的 append writer system prompt 包含：
  - `约 250 字`
- 非法值场景：
  - `99`
  - `1201`
  - 非整数
    应按现有非法 payload 语义被拒绝

### 命令验证

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## 风险与取舍

### 本期把 append 内部一致性扩到了 rewrite

产品层面 011 只新增 append 的长度选择，不新增 rewrite 控件。但服务端为了避免“短段 append 一旦 rewrite 就变回默认长文”的不一致，仍然引入了 `target_length` 持久化和 append rewrite 继承。

这属于内部一致性补强，不代表 rewrite 在本期对用户暴露了新的长度控制能力。

### 内部元数据未对外暴露

本期选择把 `targetLength` 留在服务端内部，不加到 snapshot DTO。这样改动范围更小，但前端也就无法直接看到历史每一段的目标长度。

### 历史数据无法精确补齐

011 之前生成的 append segment 没有 `target_length`。这些旧段落 future rewrite 时只能回退到默认长度策略，无法做到完全继承。
