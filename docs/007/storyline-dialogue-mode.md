# 故事线互动对话模式设计方案

## 背景

当前故事线已经支持新建、续写和重写。续写适合让故事继续向后推进，重写适合替换最近一次生成结果，但两者都偏“写一段正文”。

本期新增一种更轻量的「互动对话」模式：用户输入一段角色发言或动作，Agent 基于当前场景寻找另一个合适角色作出简短回应。这个模式强调快速、有趣、口语化，不承担长篇续写职责。

示例：

```text
用户输入：方源："冰箱里有奶茶，帮我拿过来"
模型输出：方源探头往厨房那边喊了一声："冰箱里有奶茶，帮我拿过来。"程溪没好气地白了他一眼，"你怎么不去拿，懒死你算了"，还是不情愿地起身去了厨房。
```

## 目标

- 新增 `dialogue` 模式，用户可以在已有故事线的最新章节上发起互动。
- 用户输入可以是台词，也可以是一段角色动作描写，不强制要求 `角色名: 台词` 格式。
- Agent 从当前场景中寻找另一个合适角色回应。
- 如果没有合适的另一个角色，模型输出固定短句 `无事发生`。
- 如果有多个合适角色，Agent 只选择一个角色回应。
- 模型输出短小、口语化、有活人感，优先采用「动作/神态 + 一句口语」。
- 互动内容作为正式 segment 保存，参与后续上下文和角色摘要。
- 互动 segment 不作为独立章节页展示，而是附加在上一章节末尾。
- 详情页把常驻底部输入区替换为右下角 FAB 动作入口。

## 非目标

- 本期不做多角色连续群聊。
- 本期不要求模型返回结构化角色名。
- 本期不新增用户和 Agent 的聊天记录模型。
- 本期不支持在新建故事线页面使用互动对话。
- 本期不把 dialogue 段做成独立横向章节页。
- 本期不对模型输出过长做硬截断或报错。

## 已确认决策

- 互动对话结果落为正式 `generated` segment。
- `dialogue` 请求继续复用 WebSocket `story.continue`。
- `dialogue` payload 使用 `mode: "dialogue"`。
- 用户单段输入字段命名为 `input`。
- `input` 长度上限为 1000 字。
- 前端和后端只做非空、长度校验，不强校验角色名或冒号格式。
- 模型输出完整润色正文，包含对用户输入的润色表达和另一个角色的回应。
- 前端流式阶段只展示模型输出，不额外展示用户原文。
- 模型输出作为最终 `segment.text` 保存，不由前端或服务端拼接用户原文。
- `generated` segment 新增 `generationMode: "append" | "dialogue"`。
- create 产生的首个 generated segment 也标记为 `append`。
- rewrite 成功后保留目标 segment 原有 `generationMode`。
- `dialogue` segment 保存为独立 segment，但 Reader 展示时附加到前一个章节页末尾。
- Reader 页数排除 dialogue segment，只按 initial 和 append 段落计页。
- 章节末尾的 dialogue 段使用小分隔标题展示，例如 `互动`。
- FAB 只在当前显示最新章节且页面空闲时展示。
- 生成中 FAB 在任意章节都展示为取消 icon。
- 现有 generated 段落内的文字「重写」按钮移除。
- 新建故事线页面暂时保留现有创建输入流程。
- FAB 使用 `lucide-react` 图标包。
- FAB 展开后主按钮变为关闭 icon，向上展示动作按钮。
- 动作按钮顺序从上到下为：续写、重写、互动。
- 动作按钮只展示 icon，不展示文字，但需要提供可访问的 `aria-label`。
- 点击关闭 icon 或透明遮罩收起动作按钮。
- 透明遮罩拦截点击，只收起菜单，不触发底层按钮。
- 点击动作按钮后打开底部抽屉。
- 点击抽屉外关闭抽屉，但不清空草稿。
- append、rewrite、dialogue 三种草稿独立保存。
- 提交生成后抽屉立即关闭。
- 失败和取消通过顶部居中 toast 提示。
- 生成成功不显示 toast。
- 失败或取消后不自动展开抽屉，但再次打开对应模式时恢复原草稿。
- `dialogue` 正常生成后调用 dialogue 摘要 extractor。
- 如果模型最终输出恰好为 `无事发生`，跳过摘要 extractor，角色摘要沿用 previousSummary。
- `无事发生` 仍保存为正式 dialogue segment。

## 产品交互

### FAB 动作入口

已有故事线详情页不再常驻展示底部续写输入区。

页面空闲且当前横向 Reader 停留在最新章节时，右下角展示一个圆形 FAB：

- 按钮固定在右下角安全区上方。
- 按钮有阴影。
- 按钮内部只展示 icon，不展示文字。
- 默认状态展示打开菜单 icon。

点击 FAB 后：

- 原 FAB 位置变为关闭 icon。
- 向上展开动作按钮。
- 从上到下依次为：续写、重写、互动。
- 如果当前没有可重写的最新 generated segment，隐藏重写按钮。
- 页面出现全屏透明遮罩。
- 点击关闭 icon 或遮罩收起菜单。

生成中：

- 不展示动作菜单。
- FAB 在任意章节都显示为取消 icon。
- 点击取消 icon 取消当前生成任务。

### 底部抽屉

点击续写、重写或互动后，打开底部抽屉：

- 抽屉包含模式标题、textarea、提交按钮、关闭入口。
- 点击抽屉外关闭抽屉。
- 关闭抽屉不清空草稿。
- 提交后抽屉立即关闭。

推荐文案：

```text
续写：续写指令
重写：重写指令
互动：互动输入
```

互动 placeholder 推荐：

```text
写一句角色台词或动作，例如：方源朝厨房喊了一声，让程溪帮他拿奶茶
```

### 互动生成展示

用户在最新章节发起互动后：

1. 前端提交 `mode: "dialogue"`。
2. 抽屉关闭。
3. FAB 切换为取消 icon。
4. Reader 在最新章节页末尾展示临时 `互动中` 区块。
5. 模型 delta 流式进入该临时区块。
6. 正文生成完成后，如果输出不是 `无事发生`，进入摘要阶段。
7. 摘要和保存完成后，服务端返回正式快照。
8. 前端用正式快照替换当前故事线。
9. 新 dialogue segment 附加在最新章节末尾展示。

如果模型输出为 `无事发生`：

- 服务端保存该 dialogue segment。
- 服务端跳过摘要 extractor。
- 角色摘要保持不变。
- 服务端直接返回完成事件。

### 失败与取消

失败规则：

- 当前正式故事线不变。
- 临时互动正文移除。
- 对应模式草稿保留。
- 不自动打开抽屉。
- 顶部居中 toast 展示错误文案。

取消规则：

- 当前正式故事线不变。
- 临时互动正文移除。
- 对应模式草稿保留。
- 不自动打开抽屉。
- 顶部居中 toast 展示取消文案。

## 共享契约

### `StorylineGeneratedSegment`

generated segment 新增来源字段：

```ts
export const StorylineGenerationModeSchema = z.enum(["append", "dialogue"]);

export const StorylineGeneratedSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("generated"),
    generationMode: StorylineGenerationModeSchema,
    text: z.string().trim().min(1),
  })
  .strict();
```

规则：

- `generationMode: "append"` 表示该 generated segment 是普通正文续写。
- `generationMode: "dialogue"` 表示该 generated segment 是互动对话。
- create 产生的首个 generated segment 使用 `append`。
- append 产生的 generated segment 使用 `append`。
- dialogue 产生的 generated segment 使用 `dialogue`。
- rewrite 不改变目标 segment 的 `generationMode`。

### `StoryContinueDialoguePayload`

`StoryContinuePayloadSchema` 新增 dialogue 分支：

```ts
export const StoryContinueDialoguePayloadSchema = z
  .object({
    mode: z.literal("dialogue"),
    storylineId: StorylineIdSchema,
    input: z.string().trim().min(1).max(1000),
  })
  .strict();
```

union 调整：

```ts
export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
  StoryContinueDialoguePayloadSchema,
]);
```

### 服务端事件

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

`storyline_segment` 新增来源字段：

```ts
generationMode: text("generation_mode", {
  enum: ["append", "dialogue"],
}).notNull(),
```

迁移策略：

- 现有 generated segment 默认补为 `append`。
- initial segment 也可以存 `append` 默认值，但服务端映射时只读取 generated segment 的 `generationMode`。
- 本项目是本地实验项目，不做复杂兼容分支。

保存规则：

- create 保存首个 generated segment 时写入 `generationMode: "append"`。
- append 保存新 segment 时写入 `generationMode: "append"`。
- dialogue 保存新 segment 时写入 `generationMode: "dialogue"`。
- rewrite 原地更新 segment 时不修改 `generationMode`。
- dialogue segment 仍然保存 `instruction` 字段，内容为用户原始 `input`。
- dialogue segment 仍然保存模型、耗时、token、previousSummaryJson。

## 后端设计

### 生成编排

`StorylineGenerationService.streamContinueStoryline` 增加 dialogue 分支：

```ts
if (input.payload.mode === "dialogue") {
  yield * this.streamDialogueStoryline(input, options);
  return;
}
```

dialogue 与 append/rewrite 共用故事线级锁：

- 同一故事线同一时间只能有一个 append、rewrite 或 dialogue。
- 生成中断、失败或完成后释放锁。

### Dialogue Context

新增 `StoryDialogueLlmContext`，推荐字段：

```ts
export interface StoryDialogueLlmContext {
  readonly input: string;
  readonly currentSceneText: string;
  readonly characterSummary?: StoryCharacterSummarySnapshot;
  readonly recentHistoryRounds: readonly StoryHistoryRound[];
  readonly historyWasTrimmed: boolean;
}
```

构造规则：

- `currentSceneText` 使用最新章节整页文本。
- 最新章节整页包括最新 append 段，以及附加在该章节后的所有 dialogue 段。
- 角色候选来自角色摘要和当前场景文本。
- LLM 自行推断用户输入中的发起角色；推断失败时可以输出 `无事发生`。
- 回复角色必须不同于发起角色。
- 如果当前场景没有另一个合适回复角色，输出 `无事发生`。
- 如果多个角色合适，优先选择与发起角色关系最强、对当前输入最有反应张力的一个角色。

### 历史轮次

现有 `StoryHistoryRound` 需要增加来源字段：

```ts
export interface StoryHistoryRound {
  readonly roundIndex: number;
  readonly generationMode: "append" | "dialogue";
  readonly instruction: string;
  readonly generatedText: string;
}
```

prompt 中需要明确区分历史类型：

```text
第 3 轮续写指令：
...
第 3 轮续写正文：
...

第 4 轮互动输入：
...
第 4 轮互动正文：
...
```

这样可以避免后续 Writer 把短互动误判成长续写。

### Dialogue Writer Prompt

dialogue 不复用当前 `STORY_SYSTEM_PROMPT`。现有 prompt 明确要求输出 800-1200 字，不适合互动对话。

新增独立 dialogue prompt，核心约束：

- 你在故事线当前场景中生成一次轻量互动。
- 用户输入可能是角色台词，也可能是动作描写。
- 你必须把用户输入润色进最终正文，不要原样机械复制。
- 你需要寻找当前场景中另一个合适角色回应。
- 回复角色必须不同于用户输入中的发起角色。
- 如果没有合适的另一个角色，只输出 `无事发生`。
- 如果有多个合适角色，只选择一个。
- 输出 1-2 句短反应。
- 整体建议 20-120 个中文字符。
- 角色台词应口语化，正常人一句话通常 5-25 字。
- 优先采用动作/神态加一句口语回应。
- 不要继续推进大段新剧情。
- 不要输出标题、解释、列表、JSON 或调试信息。

### Dialogue 摘要

`StorySummaryOperation` 增加 `dialogue`：

```ts
export type StorySummaryOperation = "append" | "rewrite" | "dialogue";
```

摘要 prompt 标签增加：

```text
本轮互动输入：
本轮互动正文：
```

规则：

- 正常 dialogue 使用 dialogue operation 更新角色摘要。
- `previousSummary` 使用生成开始前的当前角色摘要。
- dialogue 保存时写入 `previousSummaryJson`。
- 如果 dialogue 输出为 `无事发生`，不调用摘要 extractor，当前摘要沿用 `previousSummary`。

### 保存事务

新增保存方法可命名为 `saveDialogueSegmentWithSummary`。

正常 dialogue 保存内容：

- 新增 generated segment。
- `generationMode: "dialogue"`。
- `instruction` 保存用户原始 `input`。
- `text` 保存模型输出全文。
- `previousSummaryJson` 保存生成前摘要。
- upsert 当前角色摘要。
- 更新故事线 `updatedAt`。

`无事发生` 保存内容：

- 新增 generated segment。
- `generationMode: "dialogue"`。
- `instruction` 保存用户原始 `input`。
- `text` 保存 `无事发生`。
- `previousSummaryJson` 保存生成前摘要。
- 当前角色摘要保持 `previousSummary`。
- 更新故事线 `updatedAt`。

## 前端设计

### 状态模型

`StorylineComposerMode` 扩展为：

```ts
export type StorylineComposerMode = "append" | "rewrite" | "dialogue";
```

推荐新增动作抽屉模式：

```ts
type StoryActionDrawerMode = "append" | "rewrite" | "dialogue";
```

草稿状态：

```ts
const [appendInstruction, setAppendInstruction] = useState("");
const [rewriteInstruction, setRewriteInstruction] = useState("");
const [dialogueInput, setDialogueInput] = useState("");
```

TypeScript 约束：

- 非原始 state 必须显式泛型。
- 新增结构体需要定义明确类型。
- 类型导入使用 `import type`。

### Reader Page 分组

Reader 不再简单地把每个 segment 映射为 page。

推荐页面模型：

```ts
type StorylineReaderPage =
  | Readonly<{
      id: StorylineSegmentId;
      kind: "initial";
      text: string;
      dialogueSegments: readonly StorylineDialogueSegmentView[];
    }>
  | Readonly<{
      id: StorylineSegmentId;
      kind: "append";
      text: string;
      dialogueSegments: readonly StorylineDialogueSegmentView[];
      canRewrite: boolean;
    }>;

interface StorylineDialogueSegmentView {
  readonly id: StorylineSegmentId;
  readonly text: string;
}
```

分组规则：

- initial segment 生成 initial page。
- `generationMode: "append"` 的 generated segment 生成新的 append page。
- `generationMode: "dialogue"` 的 generated segment 附加到当前最后一个 page。
- 如果遇到异常数据：dialogue segment 前没有 page，则可以创建兜底 append page 或抛出渲染保护错误；实现时推荐用兜底页面避免白屏。
- 页数只统计 initial 和 append page。

### 最新页回传

FAB 是否展示取决于当前 Reader 页是否为最新页。

`StorylineReader` 需要向 `StoryPage` 回传：

```ts
interface StorylineReaderViewportState {
  readonly currentPageIndex: number;
  readonly pageCount: number;
  readonly isViewingLatestPage: boolean;
}
```

`StoryPage` 根据 `isViewingLatestPage && !isGenerating && storyline !== null` 决定是否展示动作 FAB。

生成中则忽略页码，始终展示取消 FAB。

### 临时生成展示

临时状态需要区分三类：

- append：追加一个末尾临时页。
- rewrite：在目标 segment 位置下方展示重写中。
- dialogue：附加到最新章节页末尾，展示 `互动中`。

推荐类型：

```ts
type ActiveGenerationIntent =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "append" }>
  | Readonly<{ type: "rewrite"; segmentId: StorylineSegmentId }>
  | Readonly<{ type: "dialogue" }>;
```

dialogue 临时展示：

- 不新增横向 page。
- 在最新章节页末尾展示分隔标题 `互动中`。
- 正文区域展示流式模型输出。
- 摘要阶段展示 `正在记录角色摘要...`。
- 如果输出为 `无事发生`，通常不会进入摘要阶段。

### Toast

新增轻量 toast 组件或 StoryPage 内部 toast 状态。

规则：

- 位置：顶部居中。
- 失败：错误样式，`role="alert"`。
- 取消：中性样式，`role="status"`。
- 自动消失。
- 成功不 toast。

推荐状态：

```ts
interface StoryToastState {
  readonly id: number;
  readonly tone: "error" | "neutral";
  readonly message: string;
}
```

## 测试建议

共享 schema：

- `StoryContinuePayloadSchema` 接受 `mode: "dialogue"`。
- dialogue `input` trim、非空、最大 1000。
- `StorylineGeneratedSegmentSchema` 要求 generated segment 携带 `generationMode`。

后端单元测试：

- dialogue prompt 不包含 800-1200 字要求。
- dialogue prompt 包含当前场景、角色摘要、用户 input。
- dialogue prompt 要求回复角色不同于发起角色。
- dialogue prompt 要求无合适角色时只输出 `无事发生`。
- history prompt 区分 append 和 dialogue。
- dialogue summary prompt 使用 `本轮互动输入` 和 `本轮互动正文`。
- dialogue 保存写入 `generationMode: "dialogue"`。
- dialogue 保存写入 `previousSummaryJson`。
- dialogue 正常完成后更新当前角色摘要。
- `无事发生` 跳过摘要 extractor，并沿用 previousSummary。
- rewrite dialogue segment 后保留 `generationMode: "dialogue"`。
- append/create segment 保持 `generationMode: "append"`。
- dialogue 和 append/rewrite 共用故事线锁。

前端测试或手工验证：

- 最新页空闲时显示 FAB。
- 非最新页空闲时隐藏 FAB。
- 生成中任意页显示取消 FAB。
- FAB 展开顺序为续写、重写、互动。
- 无可重写 segment 时隐藏重写动作。
- 点击遮罩只收起菜单，不触发底层返回等操作。
- 点击互动打开底部抽屉。
- 抽屉外点击关闭抽屉且保留草稿。
- 提交后抽屉关闭。
- dialogue 临时文本附加在最新章节页末尾。
- dialogue 完成后不新增横向页。
- dialogue 段刷新后仍显示为互动附加内容。
- 失败和取消显示顶部 toast。
- 成功不显示 toast。

## 实施顺序建议

1. 扩展共享 schema：`generationMode` 和 `dialogue` payload。
2. 扩展数据库字段和 segment DTO 映射。
3. 扩展后端 history round，支持 append/dialogue 标签。
4. 新增 dialogue Writer prompt 和后端编排。
5. 新增 dialogue 摘要 operation。
6. 新增 dialogue 保存事务和 `无事发生` 快捷保存路径。
7. 改造 Reader page 分组，让 dialogue 附加到章节末尾。
8. 新增 FAB、动作菜单、底部抽屉和 toast。
9. 接入 dialogue draft、payload 校验和临时生成展示。
10. 移除旧的段落内「重写」按钮。
11. 跑 `pnpm typecheck`、`pnpm lint`、`pnpm build` 和相关 Jest 测试。
