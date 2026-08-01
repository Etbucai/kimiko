# 故事上下文与角色认知服务端技术方案

## 背景

本文档对应 PRD：[story-context-prd.md](./story-context-prd.md)。

本期服务端目标是把现有“角色摘要”系统替换为“故事上下文”系统。现有实现通过 `StorylineSummaryService` 维护 `StoryCharacterSummarySnapshot`，并在后续生成中把它作为全局角色摘要注入 prompt。这个模型无法区分“世界真实事实”和“某角色知道或相信的事情”，容易让角色以接近上帝视角的方式行动。

新的服务端设计将维护结构化 `StoryContextSnapshot`：

- `worldFacts`：真实发生或成立的世界事实。
- `characters`：角色完整人格、认知、主观意见、误解和行动倾向。
- `currentScene`：当前位置、时间阶段、在场角色、可观察事实和场景状态。

生成时，服务端只把当前场景可观察事实和活跃角色认知注入 writer prompt。角色行动、台词和心理只能根据自身认知与当前可观察事实生成。

## 已确认决策

- 激进替换旧 summary，不保留 summary/context 双轨。
- 对外命名从 `summary` 改为 `context`。
- 新增 HTTP 调试接口：`GET /storylines/:storylineId/context`。
- 常规故事线列表和详情不携带 context，避免 payload 过大。
- `StoryContextSnapshotSchema` 放在 `@kimiko/schema`，作为前后端共享最终契约。
- LLM extractor 的 draft schema 放在服务端内部模块，不暴露给前端。
- context extractor 输出 `StoryContextDraftSnapshot`，服务端归一化为最终 `StoryContextSnapshot`。
- 角色 ID 和世界事实 ID 都由服务端生成。
- context 内部 ID 使用可读序号：`char_1`、`fact_1`，只在单条故事线内稳定。
- 服务端按强匹配复用角色和事实：
  - 角色按 `name` / `aliases` 精确匹配。
  - 世界事实按 `kind + normalized text` 精确匹配。
- draft 中的角色关系和 fact 引用使用 `characterRefs` / `factRefs`，可引用旧 ID 或本轮 draft key。
- source 使用临时 `sourceRefs`，服务端保存时映射为真实 `sourceSegmentIds`。
- 缺失 context 的旧故事线按空 context 降级，并临时回退到现有近期 history prompt；本轮生成成功后建立新 context。
- active characters 使用确定性匹配识别：
  - 从当前指令、互动输入、当前场景和近期正文中匹配在场角色的 `name` / `aliases`。
  - 匹配为空时 fallback 到当前在场角色，上限截断。
- writer prompt 保留少量近期原文 history，但标注为“叙事承接参考，不代表角色认知”。
- context 数量上限先用常量控制，不新增 env 配置。
- rewrite 一律重算 context，即使目标段新正文是 `无事发生`。
- 只有新增 dialogue 的 `无事发生` 跳过 context 更新。
- 实时事件新增 `story.context.started`。
- 错误码新增 `STORY_CONTEXT_FAILED`。

## 非目标

- 本期不做用户可编辑 context。
- 本期不做异步 context 重试。
- 本期不做复杂实体消歧、模糊匹配或 LLM 合并建议。
- 本期不为角色、事实拆独立数据库表；仍使用单故事线 JSON 快照。
- 本期不把隐藏事实注入 writer prompt。
- 本期不新增 context 上限的 env 配置。
- 本期不维护旧 `/summary` 接口。

## 现有服务端约束

- 服务端使用 NestJS。
- 数据库使用 Drizzle ORM + SQLite。
- 共享契约集中在 `@kimiko/schema`，通过 Zod 作为 SSOT。
- `StorylineGenerationService` 编排 create / append / rewrite / dialogue。
- `StoryService` 负责 writer prompt 和正文流式生成。
- `StorylineSummaryService` 当前负责摘要 extractor，本期会替换为 `StorylineContextService`。
- `StorylineService` 当前负责故事线查询、LLM context 构造、segment 保存和 summary 保存。
- `StorylineLockService` 已提供用户级 create 锁和故事线级锁。
- `RealtimeGateway` 当前把内部 `summaryStarted` 映射为 `story.summary.started`。
- 当前 generated segment 保存 `previous_summary_json`，用于 rewrite 时从目标段之前的摘要重算。

## 共享契约变更

### 移除旧角色摘要契约

移除或停止使用：

```ts
StoryCharacterSummarySchema;
StoryCharacterSummarySnapshotSchema;
GetStorylineSummaryResponseSchema;
```

对应类型不再作为故事生成上下文使用。

### Context ID

新增通用 context ID schema：

```ts
export const StoryContextCharacterIdSchema = z
  .string()
  .trim()
  .regex(/^char_[1-9]\d*$/);

export const StoryContextFactIdSchema = z
  .string()
  .trim()
  .regex(/^fact_[1-9]\d*$/);
```

### `StoryWorldFact`

```ts
export const StoryWorldFactSchema = z
  .object({
    id: StoryContextFactIdSchema,
    kind: z.enum([
      "event",
      "setting",
      "environment",
      "relationship",
      "status",
      "term",
    ]),
    text: z.string().trim().min(1).max(360),
    status: z.enum(["active", "resolved"]),
    visibility: z.enum(["observable", "public", "hidden"]),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();
```

说明：

- `visibility` 描述事实本身的可见性状态。
- writer prompt 仍只注入 `currentScene.observableFactIds` 指向的事实。
- `public` 事实如果不在当前场景可观察集合中，也不直接注入；角色是否知道它应体现在角色 belief 中。

### `StoryCharacterBelief`

```ts
export const StoryCharacterBeliefSchema = z
  .object({
    text: z.string().trim().min(1).max(360),
    truthStatus: z.enum(["true", "false", "unknown"]),
    factIds: z.array(StoryContextFactIdSchema).max(8),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();
```

规则：

- `truthStatus: "false"` 只允许在正文已经明确产生误解时写入。
- `factIds` 可为空；错误记忆不强制关联真实事实。

### `StoryCharacterOpinion`

```ts
export const StoryCharacterOpinionSchema = z
  .object({
    target: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(360),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();
```

`target` 可以是角色 ID、事实 ID、角色名或短语。第一期不强行结构化所有观点目标。

### `StoryCharacterRelationship`

```ts
export const StoryCharacterRelationshipSchema = z
  .object({
    targetCharacterId: StoryContextCharacterIdSchema,
    text: z.string().trim().min(1).max(360),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(12),
  })
  .strict();
```

### `StoryCharacterContext`

```ts
export const StoryCharacterContextSchema = z
  .object({
    id: StoryContextCharacterIdSchema,
    name: z.string().trim().min(1).max(80),
    aliases: z.array(z.string().trim().min(1).max(80)).max(10),
    identity: z.string().trim().max(360),
    traits: z.array(z.string().trim().min(1).max(120)).max(20),
    relationships: z.array(StoryCharacterRelationshipSchema).max(30),
    motivations: z.array(z.string().trim().min(1).max(180)).max(20),
    currentStatus: z.string().trim().max(360),
    beliefs: z.array(StoryCharacterBeliefSchema).max(30),
    opinions: z.array(StoryCharacterOpinionSchema).max(20),
    actionTendencies: z.array(z.string().trim().min(1).max(180)).max(12),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).min(1).max(20),
  })
  .strict();
```

### `StoryCurrentScene`

```ts
export const StoryCurrentSceneSchema = z
  .object({
    location: z.string().trim().max(160),
    timeLabel: z.string().trim().max(160),
    presentCharacterIds: z.array(StoryContextCharacterIdSchema).max(20),
    observableFactIds: z.array(StoryContextFactIdSchema).max(40),
    sceneStatus: z.string().trim().max(600),
    sourceSegmentIds: z.array(StorylineSegmentIdSchema).max(12),
  })
  .strict();
```

空 context 降级时，服务端内部可使用空字符串和空数组；正常持久化的 context 应尽量填充 `currentScene`。

### `StoryContextSnapshot`

```ts
export const StoryContextSnapshotSchema = z
  .object({
    worldFacts: z.array(StoryWorldFactSchema).max(80),
    characters: z.array(StoryCharacterContextSchema).max(20),
    currentScene: StoryCurrentSceneSchema,
  })
  .strict();

export type StoryContextSnapshot = z.infer<typeof StoryContextSnapshotSchema>;
```

### `GetStorylineContextResponse`

```ts
export const GetStorylineContextResponseSchema = z
  .object({
    context: StoryContextSnapshotSchema.nullable(),
  })
  .strict();
```

### WebSocket 事件

新增：

```ts
export const StoryContextStartedServerEventSchema = z
  .object({
    type: z.literal("story.context.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();
```

移除或停止使用：

```ts
StorySummaryStartedServerEventSchema;
```

错误码新增：

```ts
"STORY_CONTEXT_FAILED";
```

`StoryRealtimeServerEventSchema` 使用 `story.context.started` 替代 `story.summary.started`。

## 服务端内部 Draft 契约

LLM extractor 不直接输出最终 schema，而是输出服务端内部 draft。

原因：

- 新生成 segment 的真实 ID 在 extractor 阶段尚不存在。
- 角色 ID 和 fact ID 由服务端生成。
- 新增角色、事实之间需要互相引用。

### Source Ref

extractor prompt 中会给出可用 source refs：

```ts
type StoryContextSourceRef =
  "initial" | "current" | `segment:${StorylineSegmentId}`;
```

语义：

- `initial`：create 中的初始正文；已有故事线时也可映射到 initial segment id。
- `current`：本轮新生成正文。rewrite 时映射到目标 segment id。
- `segment:<id>`：已有正式 segment。

服务端保存前把 draft 中所有 `sourceRefs` 映射为最终 `sourceSegmentIds`。

### Draft ID Ref

draft 中可用两类引用：

- 旧 ID：例如 `char_1`、`fact_2`。
- 本轮 draft key：例如 `draftCharacterKey: "new_guard"`、`draftFactKey: "door_locked"`。

服务端归一化时建立映射：

```text
draft character key -> final character id
draft fact key -> final fact id
```

### Draft Snapshot 草案

服务端内部定义：

```ts
type StoryContextDraftSnapshot = Readonly<{
  worldFacts: readonly StoryWorldFactDraft[];
  characters: readonly StoryCharacterContextDraft[];
  currentScene: StoryCurrentSceneDraft;
}>;

type StoryWorldFactDraft = Readonly<{
  existingId?: string;
  draftKey?: string;
  kind: StoryWorldFact["kind"];
  text: string;
  status: StoryWorldFact["status"];
  visibility: StoryWorldFact["visibility"];
  sourceRefs: readonly string[];
}>;

type StoryCharacterContextDraft = Readonly<{
  existingId?: string;
  draftKey?: string;
  name: string;
  aliases: readonly string[];
  identity: string;
  traits: readonly string[];
  relationships: readonly StoryCharacterRelationshipDraft[];
  motivations: readonly string[];
  currentStatus: string;
  beliefs: readonly StoryCharacterBeliefDraft[];
  opinions: readonly StoryCharacterOpinionDraft[];
  actionTendencies: readonly string[];
  sourceRefs: readonly string[];
}>;

type StoryCharacterRelationshipDraft = Readonly<{
  targetCharacterRefs: readonly string[];
  text: string;
  sourceRefs: readonly string[];
}>;

type StoryCharacterBeliefDraft = Readonly<{
  text: string;
  truthStatus: "true" | "false" | "unknown";
  factRefs: readonly string[];
  sourceRefs: readonly string[];
}>;

type StoryCharacterOpinionDraft = Readonly<{
  target: string;
  text: string;
  sourceRefs: readonly string[];
}>;

type StoryCurrentSceneDraft = Readonly<{
  location: string;
  timeLabel: string;
  presentCharacterRefs: readonly string[];
  observableFactRefs: readonly string[];
  sceneStatus: string;
  sourceRefs: readonly string[];
}>;
```

约束：

- `existingId` 和 `draftKey` 至少存在一个。
- `draftKey` 只在单次 extractor 输出内有效。
- draft key 只允许 `[a-zA-Z0-9_-]`，最大 80。
- draft 中的 refs 如果无法解析，归一化失败，本轮生成失败。

## 数据库设计

### 表结构

替换现有 `storyline_summary`：

```ts
export const storylineContexts = sqliteTable(
  "storyline_context",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    contextJson: text("context_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_context_storyline_id_unique").on(table.storylineId),
  ],
);
```

`storyline_segment` 替换字段：

```ts
previousContextJson: text("previous_context_json"),
```

### 迁移策略

本项目不考虑兼容旧数据，迁移采用激进策略：

1. 删除或停用 `storyline_summary`。
2. 创建 `storyline_context`。
3. `storyline_segment.previous_summary_json` 替换为 `previous_context_json`。
4. 服务端 schema 和业务代码停止引用 summary 字段。

SQLite 迁移实现可以采用两种方式：

- 如果当前 SQLite 支持，使用 `DROP TABLE`、`DROP COLUMN`、`ADD COLUMN`。
- 如果迁移工具生成表重建脚本，接受重建 `storyline_segment`。

无论物理旧列是否被迁移脚本立即删除，业务 schema 不再暴露 `previousSummaryJson`。

## Context 模块设计

### 文件组织

推荐替换现有 summary 模块：

```text
packages/server/src/storyline/
  storyline-context.service.ts
  storyline-context.types.ts
  storyline-context-normalize.ts
  storyline-context.service.spec.ts
  storyline-context-normalize.spec.ts
```

移除或停用：

```text
storyline-summary.service.ts
storyline-summary.types.ts
```

### `StorylineContextService`

职责：

- 构造 context extractor prompt。
- 调用 `LlmService.generateTextFromParsedRequest`。
- 解析纯 JSON draft。
- 调用归一化逻辑生成最终 `StoryContextSnapshot`。
- 将 extractor 失败统一映射为 `StoryContextFailedError`。

推荐公开方法：

```ts
async generateStoryContext(
  input: GenerateStoryContextInput,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<StoryContextSnapshot>;
```

`GenerateStoryContextInput`：

```ts
export type StoryContextOperation =
  "create" | "append" | "rewrite" | "dialogue";

export interface GenerateStoryContextInput {
  readonly operation: StoryContextOperation;
  readonly previousContext: StoryContextSnapshot | null;
  readonly sourceRefMappings: readonly StoryContextSourceRefMapping[];
  readonly initialStoryText?: string;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly currentInstruction: string;
  readonly generatedText: string;
}

export interface StoryContextSourceRefMapping {
  readonly ref: string;
  readonly label: string;
  readonly text: string;
}
```

说明：

- `sourceRefMappings` 提供给 extractor 作为“允许引用的来源列表”。
- extractor 只能输出来源列表中存在的 `sourceRefs`。
- `previousContext` 为 `null` 或缺失时，服务端使用 empty context 参与 prompt。

### 空 Context

服务端内部定义：

```ts
export const emptyStoryContextSnapshot: StoryContextSnapshot = {
  worldFacts: [],
  characters: [],
  currentScene: {
    location: "",
    timeLabel: "",
    presentCharacterIds: [],
    observableFactIds: [],
    sceneStatus: "",
    sourceSegmentIds: [],
  },
};
```

HTTP `GET /context` 对缺失持久化 context 返回 `null`，不返回 empty object。

## 归一化算法

输入：

- `previousContext`
- `draftContext`
- `sourceRefToSegmentId`

输出：

- `StoryContextSnapshot`

### Source 映射

处理步骤：

1. 建立 `sourceRefToSegmentId`。
2. 遍历 draft 中所有 `sourceRefs`。
3. 对每个 source ref 查表映射为真实 external segment id。
4. 去重并排序。
5. 如果某个 source ref 不存在，归一化失败。

### 角色 ID 分配

处理步骤：

1. 从 `previousContext.characters` 建立索引：
   - `id -> character`
   - normalized `name -> id`
   - normalized aliases -> id
2. 遍历 draft characters。
3. 如果 `existingId` 命中旧角色，复用。
4. 否则按 `name` / `aliases` 精确强匹配旧角色，命中则复用。
5. 否则分配新 ID：`char_${nextIndex}`。
6. `nextIndex` 从旧 context 中最大 char 序号 + 1 开始。
7. 建立 `draftKey -> finalCharacterId` 映射。

强匹配规则：

- trim。
- 大小写不敏感。
- 合并连续空白。
- 不做模糊匹配。
- 不做拼音、同义词或相似度判断。

### 世界事实 ID 分配

处理步骤：

1. 从 `previousContext.worldFacts` 建立索引：
   - `id -> fact`
   - `${kind}:${normalizedText} -> id`
2. 遍历 draft facts。
3. 如果 `existingId` 命中旧事实，复用。
4. 否则按 `kind + normalized text` 强匹配旧事实，命中则复用。
5. 否则分配新 ID：`fact_${nextIndex}`。
6. `nextIndex` 从旧 context 中最大 fact 序号 + 1 开始。
7. 建立 `draftKey -> finalFactId` 映射。

### 引用解析

处理：

- `relationship.targetCharacterRefs` 解析为最终 `targetCharacterId`。
- `belief.factRefs` 解析为最终 `factIds`。
- `currentScene.presentCharacterRefs` 解析为最终 `presentCharacterIds`。
- `currentScene.observableFactRefs` 解析为最终 `observableFactIds`。

规则：

- ref 可以是旧 ID，也可以是本轮 draft key。
- 无法解析的 ref 导致 context 失败。
- relationship 如果解析出多个角色，展开为多条 relationship。
- fact refs 解析后去重。

### 上限处理

上限使用常量：

```ts
const STORY_CONTEXT_LIMITS = {
  characters: 20,
  worldFacts: 80,
  characterBeliefs: 30,
  characterOpinions: 20,
  characterRelationships: 30,
  characterActionTendencies: 12,
  activeCharacters: 8,
  observableFactsForPrompt: 40,
} as const;
```

服务端强校验最终 snapshot，超过上限视为 context 失败。

原因：

- extractor prompt 已要求合并、压缩、删除低价值条目。
- 如果 LLM 仍输出超限，直接失败比服务端静默裁剪更可控。

## Writer Context 设计

### 新 Context 类型

替换 `characterSummary`：

```ts
export interface StoryWriterContextBundle {
  readonly storyContext: StoryContextSnapshot;
  readonly observableFacts: readonly StoryWorldFact[];
  readonly activeCharacters: readonly StoryCharacterContext[];
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
  readonly contextWasMissing: boolean;
}
```

append writer：

```ts
export interface StoryLlmContext {
  readonly currentInstruction: string;
  readonly initialStoryText?: string;
  readonly contextBundle: StoryWriterContextBundle;
}
```

rewrite writer：

```ts
export interface StoryRewriteLlmContext {
  readonly rewriteInstruction: string;
  readonly originalInstruction: string;
  readonly originalGeneratedText: string;
  readonly initialStoryText?: string;
  readonly contextBundle: StoryWriterContextBundle;
}
```

dialogue writer：

```ts
export interface StoryDialogueLlmContext {
  readonly input: string;
  readonly currentSceneText: string;
  readonly contextBundle: StoryWriterContextBundle;
}
```

dialogue rewrite 同理替换 `characterSummary`。

### Active Character 识别

输入：

- `storyContext.currentScene.presentCharacterIds`
- 当前指令 / 互动输入 / 重写要求
- 近期 history rounds

算法：

1. 从 `presentCharacterIds` 找到角色对象。
2. 为每个在场角色构建 name/aliases token。
3. 构造 searchable text：
   - 当前指令、互动输入或重写要求。
   - `currentScene.sceneStatus`。
   - 最近若干 history rounds 的 instruction 和 generatedText。
4. 精确包含匹配 token。
5. 命中角色进入 active set。
6. 如果 active set 为空，fallback 到在场角色。
7. 按 `currentScene.presentCharacterIds` 顺序排序。
8. 截断到 `STORY_CONTEXT_LIMITS.activeCharacters`。

如果 context 缺失或 currentScene 无在场角色：

- active characters 为空。
- writer prompt 回退到现有 history + initial story 的模式。

### Observable Facts 选择

输入：

- `storyContext.currentScene.observableFactIds`
- `storyContext.worldFacts`

算法：

1. 按 `observableFactIds` 顺序查找 world facts。
2. 只保留存在的 fact。
3. 截断到 `STORY_CONTEXT_LIMITS.observableFactsForPrompt`。
4. 不注入隐藏事实。
5. 不自动注入所有 public facts。

## Writer Prompt 调整

### Prompt 分区

writer user prompt 增加结构化区块：

```text
当前可观察世界事实：
1. [fact_1][environment][observable] 门从里面锁住了。

活跃角色认知：
角色 [char_1] 方源：
- 身份：...
- 当前状态：...
- 已知/相信：
  - [true] 他知道门锁住了。
  - [false] 他误以为钥匙在程溪身上。
- 主观意见：
  - 对程溪：...
- 行动倾向：
  - ...

近期正文轨迹（只作叙事承接参考，不代表任何角色知道其中全部信息）：
...
```

约束文案：

```text
写某个角色的行动、台词和心理时，只能使用该角色自己的认知，以及当前可观察世界事实。
不要让角色使用其它角色独有的认知。
不要让角色使用未出现在“当前可观察世界事实”中的隐藏事实。
近期正文轨迹只用于承接语气和动作，不代表所有角色都知道其中信息。
如果角色认知与世界事实冲突，角色可以按错误认知行动，但环境反馈按世界事实成立。
```

### 缺失 Context 降级

当 `contextWasMissing === true`：

- prompt 不输出空的“活跃角色认知”区块。
- 使用现有的 initial story + recent history prompt。
- 增加轻量说明：当前没有可用故事上下文，请优先承接近期正文。
- 本轮生成成功后仍调用 context extractor 建立 context。

## Context Extractor Prompt

### System Prompt

新增 `STORY_CONTEXT_SYSTEM_PROMPT`：

```text
你是 StoryAgent 的故事上下文维护器。
你只负责维护结构化故事上下文，不负责续写正文。
你必须只输出 JSON，不输出解释、Markdown 或额外文本。
你只能根据输入中的旧故事上下文、来源列表、历史片段、当前指令和本轮正文更新上下文。
不要创造输入中没有依据的新事实。
不要主动制造错误记忆；只有正文明确表现角色误解时，才记录 false belief。
输出必须符合 StoryContextDraftSnapshot JSON schema。
```

### User Prompt 内容

包含：

- 输出 JSON schema 说明。
- 上下文数量上限。
- 可用 `sourceRefs` 列表。
- 旧 context。
- 初始正文（未裁剪时）。
- 近期故事上下文。
- 本轮操作类型。
- 本轮指令 / 互动输入 / 重写要求。
- 本轮生成正文。
- 旧 ID 使用规则。
- draft key 使用规则。

### Source Ref 列表示例

```text
可用来源：
- initial：初始故事正文
- segment:12：第 1 轮续写正文
- segment:13：第 2 轮互动正文
- current：本轮生成正文
```

create 时：

```text
可用来源：
- initial：初始故事正文
- current：本轮生成正文
```

rewrite 时：

```text
可用来源：
- initial：初始故事正文
- segment:12：目标段之前的上下文正文
- current：重写后的目标段正文
```

rewrite 的 `current` 保存时映射为目标 segment id。

## 生成编排调整

### Create

流程：

1. 获取 create lock。
2. writer 根据 initial story 和 instruction 流式生成正文。
3. 正文完成后 yield `{ type: "contextStarted" }`。
4. 调用 `StorylineContextService.generateStoryContext`。
5. 传入：
   - `operation: "create"`
   - `previousContext: null`
   - source refs: `initial`、`current`
   - initial story text
   - current instruction
   - generated text
6. `StorylineService.saveCreatedStorylineWithContextDraft` 在事务中：
   - 插入 storyline。
   - 插入 initial segment。
   - 插入 generated segment。
   - 建立 `initial/current -> segment id` 映射。
   - 归一化 draft 为 final context。
   - 保存 `storyline_context`。
   - 保存 generated segment 的 `previous_context_json` 为 empty context。

说明：

- context extractor 在持久化前执行。
- ID 和 source refs 的最终映射在保存事务内完成。

### Append

流程：

1. 获取故事线锁。
2. `StorylineService.buildLlmContext` 读取当前 context。
3. 如果 context 缺失，使用 empty context，并设置 `contextWasMissing: true`。
4. 构造 writer context bundle。
5. writer 流式生成正文。
6. 正文完成后 yield `contextStarted`。
7. 调用 context extractor。
8. `saveAppendedSegmentWithContextDraft` 在事务中：
   - 插入 append generated segment。
   - 保存 `previous_context_json` 为旧 context 或 empty context。
   - 将 `current` source ref 映射到新 segment id。
   - 归一化并 upsert `storyline_context`。
   - 更新 storyline `updatedAt`。

### Dialogue

正常 dialogue：

1. 获取故事线锁。
2. 读取当前 context 和 currentScene。
3. 构造 dialogue writer context。
4. writer 流式生成互动正文。
5. 如果结果不是 `无事发生`：
   - yield `contextStarted`。
   - 调用 context extractor，operation 为 `dialogue`。
   - 保存 dialogue segment、`previous_context_json` 和新 context。

`无事发生` dialogue：

1. 保存 dialogue segment。
2. 保存 `previous_context_json` 为当前 context 或 empty context。
3. 不调用 context extractor。
4. 不更新 `storyline_context`。
5. 直接返回 completed。

### Rewrite

流程：

1. 获取故事线锁。
2. 校验目标 segment 是最新 generated segment。
3. 读取目标 segment 的 `previous_context_json`。
4. 如果缺失，使用 empty context 降级。
5. 基于目标段之前的 context 构造 writer context。
6. 根据目标 `generationMode` 选择 append rewrite writer 或 dialogue rewrite writer。
7. writer 流式生成完整替换正文。
8. 正文完成后 yield `contextStarted`。
9. 一律调用 context extractor，即使新正文为 `无事发生`。
10. `saveRewrittenSegmentWithContextDraft` 在事务中：
    - 原地更新目标 segment text / instruction / model / usage。
    - 不修改 `generationMode`。
    - `current` source ref 映射到目标 segment id。
    - 基于 `previous_context_json` 归一化新 context。
    - upsert `storyline_context`。
    - 更新 storyline `updatedAt`。

## StorylineService 调整

### 查询方法

新增：

```ts
getStoryContextForUser(
  userId: string,
  storylineId: string,
): Promise<StoryContextSnapshot | null>
```

替换：

```ts
getCharacterSummaryForUser(...)
```

### LLM Context 构造

`buildLlmContext`：

- 读取 `storyline_context`。
- 缺失时使用 empty context，并标记 `contextWasMissing`。
- 选择 recent history rounds。
- 识别 active characters。
- 选择 observable facts。
- 返回新 `StoryLlmContext`。

`buildDialogueLlmContext`：

- 使用 `storyContext.currentScene` 构造 current scene。
- current scene text 可以保留现有“最新章节 + 后续 dialogue”文本，但仅作为局部场景文本。
- 同时注入 observable facts 和 active characters。

`buildRewriteLlmContext`：

- 读取目标段 `previous_context_json`。
- 缺失时使用 empty context 降级。
- selected history 只取目标段之前的 generated rounds。
- active character 识别基于 rewrite instruction、原正文和目标段之前的 context。

### 保存方法

替换 summary 版本：

```ts
saveCreatedStorylineWithContextDraft(...)
saveAppendedSegmentWithContextDraft(...)
saveDialogueSegmentWithContextDraft(...)
saveDialogueSegmentWithoutContextUpdate(...)
saveRewrittenSegmentWithContextDraft(...)
```

这些方法负责事务内：

- 插入或更新 segment。
- 写入 `previous_context_json`。
- 建立 source ref 映射。
- 调用 context draft 归一化。
- upsert `storyline_context`。

归一化失败抛 `StoryContextFailedError` 或 `StorylineSaveFailedError`：

- draft 结构或引用无法解析：`StoryContextFailedError`。
- 数据库写入失败：`StorylineSaveFailedError`。

## Realtime 调整

内部 stream event：

```ts
export type StorylineStreamEvent =
  | Readonly<{ type: "chunk"; delta: string; sequence: number }>
  | Readonly<{ type: "contextStarted" }>
  | Readonly<{
      type: "completed";
      storyline: CompletedStorylineSnapshot;
      generatedSegmentId: string;
    }>;
```

`RealtimeGateway` 映射：

```ts
if (event.type === "contextStarted") {
  sendEvent(client, {
    type: "story.context.started",
    requestId,
  });
}
```

错误映射：

```ts
if (error instanceof StoryContextFailedError) {
  return "STORY_CONTEXT_FAILED";
}
```

文案可继续使用通用生成失败：

```text
生成失败，请稍后重试
```

## HTTP Controller 调整

移除：

```ts
GET /storylines/:storylineId/summary
```

新增：

```ts
GET /storylines/:storylineId/context
```

返回：

```ts
{
  context: StoryContextSnapshot | null;
}
```

鉴权、NotFound 处理沿用 summary 接口。

## 测试计划

### `@kimiko/schema`

覆盖：

- `StoryContextSnapshotSchema` 接受合法 context。
- 拒绝非法 ID。
- 拒绝超限数组。
- `GetStorylineContextResponseSchema` 支持 `context: null`。
- `StoryRealtimeServerEventSchema` 支持 `story.context.started`。
- `StoryRealtimeErrorCodeSchema` 支持 `STORY_CONTEXT_FAILED`。

### `StorylineContextService`

覆盖：

- 构造 extractor prompt 包含 source refs、旧 context、operation、生成正文。
- prompt 要求只输出 JSON。
- prompt 要求不创造事实、不主动制造错误记忆。
- parse draft JSON 成功。
- 空响应、非 JSON、schema 错误映射为 `StoryContextFailedError`。
- abort 后不吞掉 abort 错误。

### `storyline-context-normalize`

覆盖：

- 角色按 existingId 复用。
- 角色按 name / aliases 强匹配复用。
- 新角色分配 `char_N`。
- fact 按 existingId 复用。
- fact 按 `kind + normalized text` 强匹配复用。
- 新 fact 分配 `fact_N`。
- `sourceRefs` 映射为 `sourceSegmentIds`。
- draft key 关系解析为 final character id。
- belief factRefs 解析为 final fact ids。
- 无法解析 ref 时失败。
- 超限时失败。

### `StoryService` prompt

覆盖：

- append prompt 包含“当前可观察世界事实”。
- append prompt 包含“活跃角色认知”。
- prompt 明确近期正文只作叙事承接，不代表角色认知。
- dialogue prompt 不注入隐藏事实。
- rewrite prompt 使用 context bundle 而非旧角色摘要。
- context 缺失时回退旧 history prompt。

### `StorylineService`

覆盖：

- create 保存 context 和 `previous_context_json`。
- append 保存 previous context 和新 context。
- dialogue 正常输出保存 previous context 和新 context。
- dialogue `无事发生` 保存 segment 但不更新 context。
- rewrite 使用目标段 previous context 重算。
- rewrite `无事发生` 仍更新 context。
- 缺失 context 时 build context 降级为空 context。
- `GET /context` 对缺失 context 返回 null。

### `StorylineGenerationService`

覆盖：

- create: chunk -> contextStarted -> completed。
- append: 使用 context extractor，失败不保存。
- dialogue 正常输出：contextStarted 后 completed。
- dialogue `无事发生`：不发送 contextStarted。
- rewrite: 一律 contextStarted。
- context extractor 失败时不保存正文。
- cancel 在 context 阶段不保存正文。

### Realtime E2E

覆盖：

- `story.context.started` 事件。
- `STORY_CONTEXT_FAILED` 错误码。
- `/storylines/:id/context` 返回 context。
- `/storylines/:id/summary` 不再存在或返回 404。

## 实施步骤

1. 扩展 `@kimiko/schema`：新增 `StoryContextSnapshotSchema`、`GetStorylineContextResponseSchema`、`story.context.started`、`STORY_CONTEXT_FAILED`。
2. 调整数据库 schema：新增 `storyline_context`，替换 `previous_context_json`。
3. 新增 `StoryContextFailedError`。
4. 新增 `storyline-context.types.ts` 和 draft schema。
5. 新增 `storyline-context-normalize.ts` 及单元测试。
6. 用 `StorylineContextService` 替换 `StorylineSummaryService`。
7. 改造 `StoryService` writer context 和 prompt。
8. 改造 `StorylineService` 的 context 构造、查询和保存事务。
9. 改造 `StorylineGenerationService` 编排事件和 context extractor 调用。
10. 改造 `RealtimeGateway` 事件和错误码映射。
11. 改造 `StorylineController`：移除 summary 接口，新增 context 接口。
12. 更新服务端和 schema 测试。
13. 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`。

## 风险与对策

### 近期正文泄露隐藏事实

风险：即使不注入 hidden facts，近期正文中仍可能出现隐藏事实。

对策：

- 近期正文区块明确标注“只作叙事承接参考，不代表角色认知”。
- writer prompt 强调角色行动只看自身认知和当前可观察事实。
- 测试覆盖近期正文包含秘密但 active character 不知道的场景。

### Draft 引用无法解析

风险：LLM 输出不存在的 draft key、旧 ID 或 source ref。

对策：

- prompt 列出允许引用集合。
- 服务端严格解析，失败则本轮不保存。
- 单测覆盖所有失败路径。

### Context 体积过大

风险：20 角色、80 facts 的上限仍可能带来较大 prompt。

对策：

- writer 只注入 observable facts 和 active characters。
- extractor 超限直接失败，促使 prompt 调整。
- 后续如需要再引入 env 配置。

### 旧数据降级不完美

风险：缺失 context 的旧故事线只能靠旧 history 接续，防泄密能力弱。

对策：

- 这是一次性降级路径。
- 本轮成功后会建立 context。
- 不为旧数据设计复杂批量重建。

### 服务端 ID 强匹配误差

风险：强匹配太保守会产生重复角色或重复事实。

对策：

- 接受重复，优先避免误合并。
- 后续如产品需要，再设计用户修正或 LLM 合并建议。
