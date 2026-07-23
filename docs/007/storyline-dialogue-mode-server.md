# 故事线互动对话模式服务端技术方案

## 背景

本文档对应设计方案：[storyline-dialogue-mode.md](./storyline-dialogue-mode.md) 和前端技术方案：[storyline-dialogue-mode-fe.md](./storyline-dialogue-mode-fe.md)。

本期服务端目标是在现有 WebSocket `story.continue` 生成链路中新增 `dialogue` 模式。用户在已有故事线最新章节发起轻量互动，服务端基于当前场景和角色摘要生成一段短互动正文，并把它保存为正式 `generated` segment。互动段参与后续上下文和摘要维护，但前端展示时不作为独立章节页，而是附加在上一章节末尾。

本期还需要让服务端区分正文续写段和互动段：新增 `generationMode: "append" | "dialogue"`，并把历史裁剪从旧的轮数限制改为可配置计分制。

## 已确认决策

- `dialogue` 继续复用 WebSocket `story.continue`。
- `StoryContinuePayload` 新增 `mode: "dialogue"` 分支。
- dialogue payload 字段为 `storylineId` 和 `input`。
- `input` trim 后不能为空，最大长度 1000。
- 前端和后端都不强校验 `角色名: 台词` 格式。
- 模型输出完整润色正文，服务端不拼接用户原文。
- dialogue 输出保存为正式 `generated` segment。
- `generated` segment 新增 `generationMode: "append" | "dialogue"`。
- create 首个 generated segment 写入 `generationMode: "append"`。
- append 写入 `generationMode: "append"`。
- dialogue 写入 `generationMode: "dialogue"`。
- rewrite 成功后保留目标 segment 原有 `generationMode`。
- `StorylineSnapshot.segments[].generated` 返回 `generationMode`。
- `ListStorylinesResponse.storylines[]` 新增 `chapterCount`。
- `segmentCount` 保留，表示物理 segment 总数：initial + append + dialogue。
- `chapterCount` 表示 Reader 章节页数：initial + append。
- 列表 preview 继续展示最新 segment 文本；如果最新是 dialogue，就展示最新互动文本。
- dialogue 正常完成后调用摘要 extractor。
- 如果模型最终输出 trim 后精确等于 `无事发生`，跳过摘要 extractor。
- `无事发生` 仍保存为正式 dialogue segment。
- `无事发生` 保存时完全不更新 `storyline_summary` 表。
- 不为 dialogue 新增专用业务错误码。
- dialogue 与 append/rewrite 共用故事线级锁。
- 重写最新 dialogue segment 时使用独立 dialogue rewrite prompt。
- dialogue 生成和 dialogue 重写拆成两个 Writer Context。
- 历史裁剪改成计分制：
  - append 正文 5 分。
  - dialogue 互动 1 分。
  - 总分上限 100。
  - 分值和上限通过 env 配置。
  - 从最新 generated 往前取，总分小于等于且尽量接近上限。
  - 至少保留最新一条 generated，即使它单条超过上限。
- 移除旧 `STORY_HISTORY_ROUND_LIMIT`，不做兼容。
- `.env.example` 改造成类似 `.env` 的中文注释模式。
- 本期服务端验证命令包含 `pnpm typecheck`、`pnpm lint`、`pnpm test`。

## 非目标

- 本期不新增 HTTP 接口。
- 本期不新增 dialogue 专用 WebSocket 消息类型。
- 本期不让模型返回结构化 JSON。
- 本期不新增独立聊天记录表。
- 本期不做 dialogue 输出硬截断。
- 本期不兼容旧 `STORY_HISTORY_ROUND_LIMIT`。
- 本期不强制新增 E2E，服务端以单元测试覆盖为主。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 Drizzle ORM + SQLite。
- 启动时 `DatabaseModule` 执行 Drizzle migration。
- WebSocket 使用原生 `ws`，通过 Nest `@WebSocketGateway({ path: "/realtime" })` 暴露。
- WebSocket 鉴权使用查询参数 `accessToken`。
- `RealtimeGateway` 已维护连接级 `activeTask` 和 `AbortController`。
- 当前客户端消息只有 `story.continue` 和 `story.cancel`。
- `StorylineGenerationService` 负责 create/append/rewrite 编排。
- `StorylineLockService` 已提供用户级 create 锁和故事线级锁。
- `StoryService` 负责 Writer prompt 和流式正文生成。
- `StorylineSummaryService` 负责非流式角色摘要生成。
- `StorylineService` 负责故事线查询、上下文构造、segment 保存和 summary 保存。
- `storyline_summary` 表只保存每条故事线的当前角色摘要。
- generated segment 已保存 `previous_summary_json`，用于 rewrite 摘要重算。

## 共享契约变更

### `StorylineGenerationMode`

新增：

```ts
export const StorylineGenerationModeSchema = z.enum(["append", "dialogue"]);

export type StorylineGenerationMode = z.infer<
  typeof StorylineGenerationModeSchema
>;
```

`StorylineGeneratedSegmentSchema` 调整：

```ts
export const StorylineGeneratedSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("generated"),
    generationMode: StorylineGenerationModeSchema,
    text: z.string().trim().min(1),
  })
  .strict();
```

说明：

- initial segment 不携带 `generationMode`。
- generated segment 必须携带 `generationMode`。
- 该字段返回给前端，用于 Reader 分组。

### `StorylineListItem.chapterCount`

`StorylineListItemSchema` 新增：

```ts
chapterCount: z.number().int().positive();
```

语义：

- `segmentCount`：物理 segment 总数，包含 initial、append、dialogue。
- `chapterCount`：章节页总数，只包含 initial 和 `generationMode: "append"` 的 generated segment。

### `StoryContinueDialoguePayload`

新增：

```ts
export const StoryContinueDialoguePayloadSchema = z
  .object({
    mode: z.literal("dialogue"),
    storylineId: StorylineIdSchema,
    input: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type StoryContinueDialoguePayload = z.infer<
  typeof StoryContinueDialoguePayloadSchema
>;
```

`StoryContinuePayloadSchema` 增加 dialogue 分支：

```ts
export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
  StoryContinueDialoguePayloadSchema,
]);
```

### WebSocket 事件

正常 dialogue：

```text
story.started
-> story.chunk*
-> story.summary.started
-> story.completed
```

`无事发生` dialogue：

```text
story.started
-> story.chunk*
-> story.completed
```

说明：

- `story.completed` 结构不变。
- `generatedSegmentId` 指向新保存的 dialogue segment。
- 没有合适回复角色不是错误，不新增错误码。

## 数据库设计

### `storyline_segment.generation_mode`

`storyline_segment` 增加非空文本列：

```ts
generationMode: text("generation_mode", {
  enum: ["append", "dialogue"],
}).notNull(),
```

迁移策略：

- 新增列默认填充 `append`。
- existing generated segment 都视为 append。
- initial segment 也存 `append` 作为数据库层默认值，但 DTO 映射时 initial 不返回该字段。
- 本项目是本地实验项目，不做复杂兼容路径。

保存规则：

- create initial segment 写入 `generationMode: "append"`。
- create generated segment 写入 `generationMode: "append"`。
- append generated segment 写入 `generationMode: "append"`。
- dialogue generated segment 写入 `generationMode: "dialogue"`。
- rewrite 原地更新 segment 时不修改 `generationMode`。

## Env 设计

### 移除旧配置

移除：

```text
STORY_HISTORY_ROUND_LIMIT
```

不做兼容读取。如果用户仍配置旧变量，服务端忽略它。

### 新增配置

新增：

```text
STORY_HISTORY_APPEND_SCORE=5
STORY_HISTORY_DIALOGUE_SCORE=1
STORY_HISTORY_SCORE_LIMIT=100
```

`Env.story` 调整为：

```ts
type StoryEnvShape = Readonly<{
  historyAppendScore: number;
  historyDialogueScore: number;
  historyScoreLimit: number;
}>;
```

解析规则：

- 三个值都是正整数。
- 未配置时使用默认值：5、1、100。
- 配置非法时启动失败。

### `.env.example`

`packages/server/.env.example` 改造成类似 `.env` 的中文注释模式。

示例结构：

```dotenv
# HTTP 服务监听端口。开发环境默认监听 3000。
PORT=3000

# SQLite 数据库文件路径。相对路径会基于服务端项目根目录解析。
DATABASE_URL=./data/kimiko.sqlite

# JWT 签名密钥。生产环境必须替换为强随机密钥。
JWT_SECRET=replace-with-a-long-random-secret

# LLM 基础 URL、密钥和模型。三者必须同时配置；留空时服务端不启用真实 LLM provider。
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=

# LLM 请求超时时间，单位毫秒。留空时默认 30000。
LLM_TIMEOUT_MS=

# 故事历史裁剪计分。普通正文续写占 5 分，互动对话占 1 分，总分上限 100。
# 服务端会从最新 generated 段向前收集历史，保证总分不超过上限，并至少保留最新一条。
STORY_HISTORY_APPEND_SCORE=5
STORY_HISTORY_DIALOGUE_SCORE=1
STORY_HISTORY_SCORE_LIMIT=100
```

## 历史裁剪设计

### History Round

`StoryHistoryRound` 增加来源字段：

```ts
export interface StoryHistoryRound {
  readonly roundIndex: number;
  readonly generationMode: "append" | "dialogue";
  readonly instruction: string;
  readonly generatedText: string;
}
```

语义：

- `roundIndex` 仍按 generated segment 的物理顺序计数。
- append 和 dialogue 都是 generated round。
- `instruction` 对 append 表示续写指令，对 dialogue 表示互动 input。

### Scoring Config

新增内部类型：

```ts
interface HistoryScoreConfig {
  readonly appendScore: number;
  readonly dialogueScore: number;
  readonly scoreLimit: number;
}
```

`StorylineGenerationService` 调用上下文构造时传入：

```ts
const historyScoreConfig = {
  appendScore: Env.story.historyAppendScore,
  dialogueScore: Env.story.historyDialogueScore,
  scoreLimit: Env.story.historyScoreLimit,
};
```

### 裁剪算法

从最新 generated round 往前收集：

```ts
function selectRecentHistoryRounds(
  rounds: readonly StoryHistoryRound[],
  config: HistoryScoreConfig,
): Readonly<{ rounds: readonly StoryHistoryRound[]; wasTrimmed: boolean }> {
  const selected: StoryHistoryRound[] = [];
  let totalScore = 0;

  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined) {
      continue;
    }

    const roundScore = getHistoryRoundScore(round, config);
    if (selected.length > 0 && totalScore + roundScore > config.scoreLimit) {
      break;
    }

    selected.push(round);
    totalScore += roundScore;
  }

  selected.reverse();

  return {
    rounds: selected,
    wasTrimmed: selected.length < rounds.length,
  };
}
```

规则：

- append round 使用 `appendScore`。
- dialogue round 使用 `dialogueScore`。
- 总分尽量接近但不超过 `scoreLimit`。
- 至少保留最新一条 generated round。
- 如果没有 generated round，返回空数组。

## StoryService Writer 设计

### 不复用 `STORY_SYSTEM_PROMPT`

现有 `STORY_SYSTEM_PROMPT` 明确要求输出 800-1200 字，不适合 dialogue。

新增独立 prompt：

```ts
export const STORY_DIALOGUE_SYSTEM_PROMPT = [...].join("\n");
```

核心约束：

- 你在故事线当前场景中生成一次轻量互动。
- 用户输入可能是角色台词，也可能是动作描写。
- 必须把用户输入润色进最终正文。
- 需要寻找当前场景中另一个合适角色回应。
- 回复角色必须不同于用户输入中的发起角色。
- 如果没有合适的另一个角色，只输出 `无事发生`。
- 如果有多个合适角色，只选择一个。
- 输出 1-2 句短反应。
- 整体建议 20-120 个中文字符。
- 角色台词应口语化，正常人一句话通常 5-25 字。
- 优先采用动作/神态加一句口语回应。
- 不要继续推进大段新剧情。
- 不要输出标题、解释、列表、JSON 或调试信息。

### Dialogue Context

新增：

```ts
export interface StoryDialogueLlmContext {
  readonly input: string;
  readonly currentSceneText: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}
```

新增方法：

```ts
async *streamDialogueStoryFromContext(
  context: StoryDialogueLlmContext,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent>;
```

### Dialogue Rewrite Context

重写 dialogue 不能复用普通 rewrite prompt。

新增：

```ts
export interface StoryDialogueRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInput: string;
  readonly originalGeneratedText: string;
  readonly currentSceneText: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly recentHistoryRoundsBeforeTarget: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}
```

新增方法：

```ts
async *streamRewriteDialogueFromContext(
  context: StoryDialogueRewriteLlmContext,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent>;
```

dialogue rewrite prompt 必须包含：

- 当前场景。
- 角色摘要。
- 目标段之前的近期历史。
- 原互动输入。
- 原互动正文。
- 重写要求。
- 输出仍然是用于替换原 dialogue segment 的完整互动正文。
- 如果重写后仍无合适回复角色，可以输出 `无事发生`。

### Prompt 历史标签

append 和 rewrite 的历史 prompt 也需要识别 generationMode。

推荐标签：

```text
第 3 轮续写指令：
第 3 轮续写正文：

第 4 轮互动输入：
第 4 轮互动正文：
```

当 `historyWasTrimmed === true` 时，也不要把 dialogue 标成续写。

## StorylineService 设计

### DTO 映射

`mapSegmentDto` 调整：

```ts
function mapSegmentDto(segment: StorylineSegmentRow): StorylineSegmentDto {
  if (segment.type === "initial") {
    return {
      id: String(segment.id),
      type: "initial",
      text: segment.text,
    };
  }

  return {
    id: String(segment.id),
    type: "generated",
    generationMode: getRequiredGenerationMode(segment.generationMode),
    text: segment.text,
  };
}
```

### List Item 映射

`mapListItemDto` 新增 `chapterCount`：

```ts
function countChapters(segments: readonly StorylineSegmentRow[]): number {
  return segments.filter(
    (segment) =>
      segment.type === "initial" ||
      (segment.type === "generated" && segment.generationMode === "append"),
  ).length;
}
```

规则：

- `segmentCount` 继续使用 `segments.length`。
- `chapterCount` 使用 `countChapters(segments)`。
- `preview` 继续使用 latest physical segment。

### `mapGeneratedRounds`

`mapGeneratedRounds` 增加 generationMode：

```ts
function mapGeneratedRounds(
  segments: readonly StorylineSegmentRow[],
): StoryHistoryRound[] {
  return segments
    .filter((segment) => segment.type === "generated")
    .map((segment, index) => ({
      roundIndex: index + 1,
      generationMode: getRequiredGenerationMode(segment.generationMode),
      instruction: getRequiredString(segment.instruction, "instruction"),
      generatedText: segment.text,
    }));
}
```

### Append Context

`buildLlmContext` 参数从 `historyRoundLimit` 改为：

```ts
readonly historyScoreConfig: HistoryScoreConfig;
```

处理：

- 先构造所有 generated rounds。
- 使用计分制裁剪。
- `historyWasTrimmed` 由裁剪结果决定。
- 未裁剪时继续带 initial story text。
- 已裁剪时不带 initial story text，避免 prompt 过长。

### Rewrite Context

`buildRewriteLlmContext` 需要返回目标段来源：

```ts
export interface StorylineRewriteContext {
  readonly storyline: StorylineRecord;
  readonly targetSegmentId: string;
  readonly targetGenerationMode: "append" | "dialogue";
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly writerContext: StoryRewriteLlmContext;
  readonly dialogueWriterContext?: StoryDialogueRewriteLlmContext;
  readonly summaryHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
}
```

实现建议：

- 如果目标段 `generationMode === "append"`，构造现有 `StoryRewriteLlmContext`。
- 如果目标段 `generationMode === "dialogue"`，构造 `StoryDialogueRewriteLlmContext`。
- 为了类型更严格，也可以把返回类型改成 discriminated union。

更推荐 discriminated union：

```ts
type StorylineRewriteContext =
  | Readonly<{
      targetGenerationMode: "append";
      writerContext: StoryRewriteLlmContext;
      // shared fields...
    }>
  | Readonly<{
      targetGenerationMode: "dialogue";
      writerContext: StoryDialogueRewriteLlmContext;
      // shared fields...
    }>;
```

### Dialogue Context

新增：

```ts
async buildDialogueLlmContext(input: {
  readonly userId: string;
  readonly storylineId: string;
  readonly input: string;
  readonly historyScoreConfig: HistoryScoreConfig;
}): Promise<StorylineDialogueContext>
```

推荐类型：

```ts
export interface StorylineDialogueContext {
  readonly storyline: StorylineRecord;
  readonly previousSummary: StoryCharacterSummarySnapshot;
  readonly writerContext: StoryDialogueLlmContext;
  readonly summaryHistoryRounds: readonly StoryHistoryRound[];
  readonly initialStoryText?: string;
}
```

构造规则：

1. 校验故事线属于当前用户。
2. 查询所有 segments。
3. 找到 initial segment。
4. 找到最新章节整页文本。
5. 构造所有 generated rounds。
6. 使用计分制裁剪 recent history。
7. 读取当前角色摘要；没有则使用空摘要。
8. 构造 `StoryDialogueLlmContext`。

### 当前场景文本

当前场景是最新章节整页：

- 找到最后一个 `generationMode: "append"` 的 generated segment。
- 如果不存在 append generated，则使用 initial segment。
- 从该章节 segment 开始，拼接之后所有 `generationMode: "dialogue"` 的 generated segment。
- 中间如果出现 append，则说明那是更新章节，继续以最后一个 append 为准。

推荐输出格式：

```text
章节正文：
...

互动：
...

互动：
...
```

### 保存 dialogue

新增保存方法：

```ts
async saveDialogueSegmentWithSummary(
  input: SaveDialogueSegmentWithSummaryInput,
): Promise<CompletedStorylineSnapshot>
```

类型：

```ts
export interface SaveDialogueSegmentInput {
  readonly userId: string;
  readonly storylineId: string;
  readonly input: string;
  readonly generatedText: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: ContinueStoryUsage;
  readonly previousSummary: StoryCharacterSummarySnapshot;
}

export interface SaveDialogueSegmentWithSummaryInput extends SaveDialogueSegmentInput {
  readonly characterSummary: StoryCharacterSummarySnapshot;
}
```

保存规则：

- 在同一事务内校验故事线归属。
- 读取最新 orderIndex。
- 插入 generated segment：
  - `generationMode: "dialogue"`。
  - `text` 为模型输出 trim。
  - `instruction` 为用户 input trim。
  - 写入模型、耗时、token。
  - `previousSummaryJson` 保存生成前摘要。
- upsert `storyline_summary` 为新摘要。
- 更新 `storyline.updatedAt`。
- 返回 `CompletedStorylineSnapshot`。

### 保存 `无事发生`

新增方法可复用普通 dialogue 保存，或单独命名：

```ts
async saveDialogueSegmentWithoutSummaryUpdate(
  input: SaveDialogueSegmentInput,
): Promise<CompletedStorylineSnapshot>
```

规则：

- 插入 dialogue segment。
- 写入 `previousSummaryJson`。
- 更新 `storyline.updatedAt`。
- 不 insert/update `storyline_summary`。
- 返回 completed snapshot。

## StorylineGenerationService 设计

### 分支

`streamContinueStoryline` 增加：

```ts
if (input.payload.mode === "dialogue") {
  yield * this.streamDialogueStoryline(input, options);
  return;
}
```

### Dialogue 编排

流程：

1. 校验 payload mode。
2. 获取故事线，校验归属。
3. 获取故事线级锁。
4. 构造 `StorylineDialogueContext`。
5. 调用 `storyService.streamDialogueStoryFromContext`。
6. chunk 直接 yield。
7. completed 后 normalize 后的正文如果为 `无事发生`：
   - 不 yield `summaryStarted`。
   - 调用 `saveDialogueSegmentWithoutSummaryUpdate`。
   - yield completed。
8. completed 后正文不是 `无事发生`：
   - yield `summaryStarted`。
   - 调用 summary service，operation 为 `dialogue`。
   - 调用 `saveDialogueSegmentWithSummary`。
   - yield completed。
9. finally 释放锁。

`无事发生` 判断：

```ts
const noOpDialogueText = "无事发生";

function isNoOpDialogueText(value: string): boolean {
  return value.trim() === noOpDialogueText;
}
```

### Rewrite 编排

`streamRewriteStoryline` 需要根据目标 generationMode 分流：

```ts
const context = await this.storylineService.buildRewriteLlmContext(...);

const stream =
  context.targetGenerationMode === "dialogue"
    ? this.storyService.streamRewriteDialogueFromContext(
        context.writerContext,
        options,
      )
    : this.storyService.streamRewriteStoryFromContext(
        context.writerContext,
        options,
      );
```

summary operation 仍然是 `rewrite`，但 summary prompt 的上下文 rounds 会带 `generationMode`，历史标签会区分 append/dialogue。

如果 dialogue rewrite 输出 `无事发生`：

- 不跳过 summary。原因：rewrite 是替换既有正式段，当前摘要必须基于目标段 previousSummary 和新正文重算。
- 但 summary extractor 看到 `无事发生` 后应自然保持摘要不变。

说明：

- “跳过摘要”只适用于新增 dialogue 生成 `无事发生`。
- rewrite 不适用跳过摘要，否则旧 dialogue 对摘要的影响可能残留。

## StorylineSummaryService 设计

`StorySummaryOperation` 扩展：

```ts
export type StorySummaryOperation = "append" | "rewrite" | "dialogue";
```

`getInstructionLabel` 调整：

```ts
function getInstructionLabel(
  operation: GenerateCharacterSummaryInput["operation"],
): string {
  switch (operation) {
    case "append":
      return "本轮续写指令：";
    case "rewrite":
      return "本轮重写指令：";
    case "dialogue":
      return "本轮互动输入：";
  }
}
```

正文标签也需要区分：

```ts
function getGeneratedTextLabel(
  operation: GenerateCharacterSummaryInput["operation"],
): string {
  return operation === "dialogue" ? "本轮互动正文：" : "本轮生成正文：";
}
```

近期上下文也要使用 `StoryHistoryRound.generationMode`：

```text
第 1 轮续写指令：
...
第 1 轮续写正文：
...

第 2 轮互动输入：
...
第 2 轮互动正文：
...
```

## RealtimeGateway 影响

`RealtimeGateway` 不需要新增事件类型。

需要确认：

- `StoryRealtimeClientMessageSchema` 扩展后可 parse dialogue payload。
- `mapStreamErrorCode` 不新增 dialogue 专用错误码。
- dialogue 中 StorylineNotFound、StorylineBusy、StorylineSaveFailed、StorySummaryFailed 继续复用现有映射。

## 测试计划

### Schema 测试

如果当前 schema 包没有单独测试，可在服务端相关测试里间接覆盖；否则建议补充：

- `StoryContinuePayloadSchema` 接受 `mode: "dialogue"`。
- dialogue input trim、非空、最大 1000。
- generated segment 必须包含 `generationMode`。
- list item 包含 `chapterCount`。

### Env 测试

调整 `packages/server/src/env.spec.ts`：

- 默认 `Env.story` 为 `{ historyAppendScore: 5, historyDialogueScore: 1, historyScoreLimit: 100 }`。
- 三个新 env 可配置。
- 0、负数、非数字启动失败。
- `STORY_HISTORY_ROUND_LIMIT` 不再影响 `Env.story`。

### StoryService 测试

调整 `packages/server/src/story/story.service.spec.ts`：

- dialogue prompt 使用 `STORY_DIALOGUE_SYSTEM_PROMPT`。
- dialogue prompt 不包含 `800-1200 字`。
- dialogue prompt 包含当前场景、角色摘要、用户 input。
- dialogue prompt 要求回复角色不同于发起角色。
- dialogue prompt 要求无合适角色时只输出 `无事发生`。
- dialogue rewrite prompt 包含原互动输入、原互动正文和重写要求。
- append/rewrite 历史 prompt 区分 append 和 dialogue。

### Summary 测试

调整 `packages/server/src/storyline/storyline-summary.service.spec.ts`：

- operation 为 dialogue 时使用 `本轮互动输入：`。
- operation 为 dialogue 时使用 `本轮互动正文：`。
- 近期上下文中的 dialogue round 标为互动输入/互动正文。
- rewrite operation 仍使用 `本轮重写指令：`。

### StorylineService 测试

调整 `packages/server/src/storyline/storyline.service.spec.ts`：

- create/append 保存 `generationMode: "append"`。
- dialogue 保存 `generationMode: "dialogue"`。
- dialogue 保存 `previousSummaryJson`。
- dialogue 正常保存会 upsert summary。
- `无事发生` 保存不更新 summary。
- `StorylineSnapshot` generated segment 返回 `generationMode`。
- list item 返回 `segmentCount` 和 `chapterCount`。
- list preview 在最新 segment 为 dialogue 时展示 dialogue 文本。
- `mapGeneratedRounds` 产出 generationMode。
- 计分制裁剪 append=5、dialogue=1、limit=100。
- 计分制至少保留最新一条。
- build dialogue context 的 currentSceneText 包含最新 append 章节和其后的 dialogue。
- build rewrite context 对 dialogue target 返回 dialogue rewrite context。
- rewrite dialogue 后保留 `generationMode: "dialogue"`。

### GenerationService 测试

调整 `packages/server/src/storyline/storyline-generation.service.spec.ts`：

- dialogue 正常生成：chunk -> summaryStarted -> completed。
- dialogue 正常生成调用 summary operation `dialogue`。
- dialogue 正常生成调用 `saveDialogueSegmentWithSummary`。
- dialogue 输出 `无事发生`：chunk -> completed，不发送 summaryStarted。
- dialogue 输出 `无事发生` 调用不更新 summary 的保存方法。
- dialogue 与 append/rewrite 共用故事线锁。
- dialogue 取消时不保存。
- dialogue summary 失败时不保存。
- rewrite dialogue 时调用 `streamRewriteDialogueFromContext`。
- rewrite dialogue 输出 `无事发生` 时仍走 rewrite summary 和 save rewritten。

## 验证命令

服务端验证：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

如果实现同时改动前端契约消费，可在总体验证时追加：

```bash
pnpm build
```

## 实施顺序建议

1. 扩展共享 schema：`generationMode`、`chapterCount`、`dialogue` payload。
2. 修改 Drizzle schema 并生成 migration。
3. 调整 `Env.story`，移除 `STORY_HISTORY_ROUND_LIMIT`，新增计分配置。
4. 更新 `.env.example` 为中文注释模式。
5. 扩展 `StoryHistoryRound` 和历史裁剪工具函数。
6. 调整 append/rewrite prompt 的历史标签。
7. 新增 dialogue Writer prompt 和 dialogue rewrite prompt。
8. 扩展 `StorylineSummaryService` 支持 dialogue operation。
9. 扩展 `StorylineService`：DTO、list item、dialogue context、dialogue 保存、无事发生保存。
10. 扩展 `StorylineGenerationService`：dialogue 分支和 rewrite dialogue 分流。
11. 补齐单元测试。
12. 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`。
