# 为故事线添加重写功能前端技术方案

## 背景

本文档对应 PRD：[storyline-rewrite.md](./storyline-rewrite.md)。

本期目标是在现有故事线详情页中增加「重写上一段」能力。用户点击最新生成段上的「重写」按钮后，底部输入区切换为重写模式；用户输入重写指令并提交后，页面在目标段下方展示流式重写草稿；服务端完成正文生成、角色摘要记录和保存后，前端使用 `story.completed.storyline` 替换当前正式故事线快照。

前端不负责拼接旧正文、不负责组装重写 prompt、不展示 previousSummary，也不解析角色摘要。重写上下文、previousSummary 和摘要重算都由服务端处理。

## 已确认决策

- 本期不新增路由。
- 本期不新增前端第三方依赖。
- 重写入口只出现在最新 generated segment 上。
- initial segment 和非最新 generated segment 不展示重写入口。
- 生成中、摘要记录中或重写中，不允许进入新的重写。
- 重写按钮放在最新 generated segment 正文底部右侧。
- 底部输入区支持 `append` 和 `rewrite` 两种输入模式。
- 续写草稿和重写草稿相互独立，互不覆盖。
- 进入重写模式时，不需要二次确认，也不清空续写草稿。
- 重写模式下显示简短提示：`正在重写上一段`。
- 重写模式下输入框标签为 `重写指令`。
- 重写模式下主按钮为 `生成重写`。
- 重写模式下次要按钮为 `取消重写`。
- `取消重写` 只在空闲重写模式下显示。
- 生成中只显示主按钮 `取消生成`，不显示 `取消重写`。
- 重写指令为空时展示字段错误：`请输入重写指令`。
- 重写流式生成时，旧正式正文继续保留。
- 重写流式草稿展示在目标段下方。
- 重写流式生成时不自动滚动。
- 续写流式生成继续沿用当前 near-bottom 自动跟随逻辑。
- 重写失败或取消后，保留重写指令并停留重写模式。
- 重写成功后，清空重写指令并退出重写模式。
- 重写成功后，续写草稿保持原样。
- `storyRealtimeApi` 需要把 `story.error` 的错误码传给页面。
- `STORY_SEGMENT_NOT_REWRITABLE` 在页面通用消息区展示 `当前段落不可重写`。
- 本期前端验证要求为 typecheck 和 lint。

## 现有前端约束

- 前端使用 React、react-router、Tailwind CSS v4。
- 页面路由保持不变：
  - `/`：最近故事线。
  - `/storylines`：故事线列表。
  - `/storylines/new`：新故事线。
  - `/storylines/:storylineId`：故事线详情。
- API base URL 来自 `VITE_API_BASE_URL`。
- WebSocket base URL 继续从 `VITE_API_BASE_URL` 推导。
- 登录态保存在 `localStorage`，通过 `getStoredAuthSession()` 读取。
- 本地登录态失效时，页面跳转 `/login`。
- 共享契约使用 `@kimiko/schema` 的 Zod schema 和类型。
- TypeScript 文件必须保持严格类型安全，避免 `any`。
- 非原始值 `useState`、`useRef` 必须显式标注泛型。
- 类型导入使用 `import type`。

## IDL Schema

本期前端需要扩展 WebSocket 客户端 payload 和错误码。HTTP 恢复接口、列表接口、详情接口和 `story.completed` 快照结构不变。

### 新增 Rewrite Payload

`StoryContinuePayloadSchema` 新增 `rewrite` 分支：

```ts
export const StoryContinueRewritePayloadSchema = z
  .object({
    mode: z.literal("rewrite"),
    storylineId: StorylineIdSchema,
    segmentId: StorylineSegmentIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueRewritePayload = z.infer<
  typeof StoryContinueRewritePayloadSchema
>;
```

`StoryContinuePayloadSchema` 更新为：

```ts
export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
]);
```

说明：

- 前端重写仍发送 `story.continue`。
- `mode: "rewrite"` 表示本次请求是重写最新生成段。
- `storylineId` 是当前故事线 id。
- `segmentId` 是目标 generated segment id。
- `instruction` 是用户输入的重写指令。
- 前端不传目标段旧正文。
- 前端不传 previousSummary。
- 前端不传角色摘要。

### WebSocket 错误码扩展

`StoryRealtimeErrorCodeSchema` 新增：

```ts
"STORY_SEGMENT_NOT_REWRITABLE"
```

完整错误码 union 更新为：

```ts
export const StoryRealtimeErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "INVALID_PAYLOAD",
  "BUSY",
  "NO_ACTIVE_TASK",
  "GENERATION_FAILED",
  "LLM_EMPTY_RESPONSE",
  "LLM_USAGE_MISSING",
  "STORYLINE_NOT_FOUND",
  "STORYLINE_BUSY",
  "STORYLINE_SAVE_FAILED",
  "STORY_SUMMARY_FAILED",
  "STORY_SEGMENT_NOT_REWRITABLE",
]);
```

说明：

- `STORY_SEGMENT_NOT_REWRITABLE` 表示目标段不可重写。
- 前端收到该错误码后展示：`当前段落不可重写`。
- 该错误展示在页面通用生成消息区，不展示为输入框字段错误。
- 收到该错误后，当前正式故事线快照不变，重写临时正文清空，重写指令保留，页面停留重写模式。

### 不变事件

`story.completed` 不新增字段：

```ts
export const StoryCompletedServerEventSchema = z
  .object({
    type: z.literal("story.completed"),
    requestId: StoryRealtimeRequestIdSchema,
    storyline: CompletedStorylineSnapshotSchema,
    generatedSegmentId: StorylineSegmentIdSchema,
  })
  .strict();
```

说明：

- 前端仍以 `event.storyline` 作为唯一正式故事线快照来源。
- 重写成功后，前端不自行替换 segment 文本。
- 前端不依赖 `generatedSegmentId` 区分 append 和 rewrite。
- 是否为 rewrite 由当前页面的 `activeGenerationIntent` 决定。

事件顺序继续沿用：

```text
story.started
-> story.chunk*
-> story.summary.started
-> story.completed | story.cancelled | story.error
```

## 文件调整

需要调整以下文件：

- `packages/schema/src/index.ts`
  - 新增 `StoryContinueRewritePayloadSchema`。
  - 新增 `StoryContinueRewritePayload` 类型。
  - `StoryContinuePayloadSchema` 增加 rewrite 分支。
  - `StoryRealtimeErrorCodeSchema` 增加 `STORY_SEGMENT_NOT_REWRITABLE`。
- `packages/web/src/story/storyRealtimeApi.ts`
  - `StoryRealtimeGenerationCallbacks.onError` 从只接收 message 调整为接收错误事件或结构化错误对象。
  - 收到 `story.error` 时把 `code` 和 `message` 一起传给页面。
  - 继续复用 `startStoryRealtimeGeneration(payload, callbacks)`。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 增加输入模式和生成意图状态。
  - 拆分续写草稿和重写草稿。
  - 增加重写 payload 校验。
  - 根据生成意图处理 chunk、summary、completed、cancelled、error。
  - 重写生成时禁用自动滚动。
  - 离开页面确认覆盖重写草稿。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - 识别最新 generated segment。
  - 在最新 generated segment 底部右侧展示「重写」按钮。
  - 支持在目标 segment 下方展示重写临时正文。
  - 重写生成中不在故事线末尾展示临时正文。
- `packages/web/src/pages/story/StorylineComposer.tsx`
  - 支持 append/rewrite 两种输入模式。
  - 支持模式提示、动态 label、动态 placeholder、动态主按钮。
  - 支持空闲重写模式下展示「取消重写」次要按钮。

不需要调整：

- `packages/web/src/App.tsx`
  - 路由不变。
- `packages/web/src/story/storylineApi.ts`
  - HTTP 接口不变。
- `packages/web/src/pages/story/StorylineListPage.tsx`
  - 列表数据由服务端 `GET /storylines` 派生，重写成功后的列表 preview 和 updatedAt 由服务端返回结果决定。
- `packages/web/src/pages/story/StoryInitialInput.tsx`
  - 初始故事正文输入规则不变。
- `packages/web/src/pages/story/StorySummaryDrawer.tsx`
  - 角色摘要查看逻辑不变。

## Realtime API 设计

### Callback 类型

`storyRealtimeApi.ts` 需要暴露结构化错误。

推荐新增类型：

```ts
export interface StoryRealtimeGenerationError {
  readonly code: StoryRealtimeErrorCode | "UNKNOWN";
  readonly message: string;
  readonly retryable: boolean;
}
```

callback 调整为：

```ts
export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onSummaryStarted: () => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onError: (error: StoryRealtimeGenerationError) => void;
  onAuthRequired: () => void;
}
```

说明：

- 正常 `story.error` 使用服务端返回的 `code/message/retryable`。
- 无法解析服务端事件、socket error、非认证 close 等前端本地错误使用 `code: "UNKNOWN"`。
- 页面负责把 `STORY_SEGMENT_NOT_REWRITABLE` 映射成特定文案。
- 其他错误沿用服务端 message；message 为空时使用通用文案。

### 发送 Rewrite 请求

重写仍调用：

```ts
startStoryRealtimeGeneration(payload, callbacks)
```

payload 示例：

```ts
{
  mode: "rewrite",
  storylineId: storyline.id,
  segmentId: rewriteTargetSegmentId,
  instruction: rewriteInstruction,
}
```

`storyRealtimeApi.ts` 不需要知道 payload 是 append 还是 rewrite，只负责发送、解析和回调。

## 页面状态模型

### 类型设计

保留现有生成阶段：

```ts
type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
  | "summarizing"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";
```

新增输入模式：

```ts
type ComposerMode = "append" | "rewrite";
```

新增生成意图：

```ts
type GenerationIntent =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "append" }>
  | Readonly<{ type: "rewrite"; segmentId: StorylineSegmentId }>;
```

新增重写临时正文状态：

```ts
interface RewriteDraftState {
  readonly targetSegmentId: StorylineSegmentId;
  readonly text: string;
}
```

页面建议维护：

```ts
const [composerMode, setComposerMode] = useState<ComposerMode>("append");
const [appendInstruction, setAppendInstruction] = useState("");
const [rewriteInstruction, setRewriteInstruction] = useState("");
const [rewriteTargetSegmentId, setRewriteTargetSegmentId] =
  useState<StorylineSegmentId | null>(null);
const [activeGenerationIntent, setActiveGenerationIntent] =
  useState<GenerationIntent | null>(null);
const [temporaryAppendText, setTemporaryAppendText] = useState("");
const [temporaryRewrite, setTemporaryRewrite] =
  useState<RewriteDraftState | null>(null);
```

说明：

- 新建故事线仍使用 `initialStoryText` 和 `appendInstruction`。
- 已有故事线续写使用 `appendInstruction`。
- 重写模式使用 `rewriteInstruction`。
- `activeGenerationIntent` 只描述当前正在执行的任务。
- `composerMode` 描述当前底部输入区展示模式。
- 失败或取消后，`composerMode` 可以继续停留在 `rewrite`。
- 成功后，若 `activeGenerationIntent.type === "rewrite"`，退出重写模式。

### 派生状态

```ts
const isGenerating =
  status === "connecting" ||
  status === "streaming" ||
  status === "summarizing";

const isRewriteMode = composerMode === "rewrite";
const canEnterRewrite = !isGenerating && storyline !== null;
```

最新 generated segment 可通过 `storyline.segments` 从后往前查找：

```ts
function getLatestGeneratedSegment(
  storyline: StorylineSnapshot,
): StorylineGeneratedSegment | null
```

`StorylineReader` 只对该 segment 展示重写按钮。

## 提交流程

### Create / Append

create 和 append 继续沿用现有流程，但输入字段从 `instruction` 改为 `appendInstruction`。

校验错误：

- 空初始正文：`请输入故事正文`。
- 空续写指令：`请输入续写指令`。

提交后：

- 设置 `activeGenerationIntent` 为 `create` 或 `append`。
- 清空对应临时正文。
- 清空通用状态消息。
- 设置 `status` 为 `connecting`。
- 调用 `startStoryRealtimeGeneration()`。

### Rewrite

重写提交前校验：

- `storyline` 必须存在。
- `rewriteTargetSegmentId` 必须存在。
- `rewriteInstruction.trim()` 不能为空。

字段错误：

```text
请输入重写指令
```

提交 payload：

```ts
{
  mode: "rewrite",
  storylineId: storyline.id,
  segmentId: rewriteTargetSegmentId,
  instruction: rewriteInstruction.trim(),
}
```

提交后：

- 设置 `activeGenerationIntent` 为 `{ type: "rewrite", segmentId }`。
- 清空 `temporaryRewrite`。
- 清空通用状态消息。
- 设置 `status` 为 `connecting`。
- 调用 `startStoryRealtimeGeneration()`。

## 事件处理

### `story.started`

- 设置 `status` 为 `streaming`。
- create / append：按现有 near-bottom 规则决定是否跟随滚动。
- rewrite：不触发自动滚动。

### `story.chunk`

create / append：

- 追加到 `temporaryAppendText`。
- 续写场景继续按 near-bottom 规则自动跟随。

rewrite：

- 追加到 `temporaryRewrite.text`。
- `temporaryRewrite.targetSegmentId` 使用 `activeGenerationIntent.segmentId`。
- 不自动滚动。

### `story.summary.started`

- 设置 `status` 为 `summarizing`。
- create / append：保留临时续写正文。
- rewrite：保留目标段下方的临时重写正文。
- rewrite 不自动滚动。

### `story.completed`

通用处理：

- `generationHandleRef.current = null`。
- 使用 `event.storyline` 替换当前正式故事线。
- 清空通用状态消息。
- 设置 `status` 为 `completed`。

create：

- 清空 `initialStoryText`。
- 清空 `appendInstruction`。
- 跳转到 `/storylines/:id`。

append：

- 清空 `temporaryAppendText`。
- 清空 `appendInstruction`。

rewrite：

- 清空 `temporaryRewrite`。
- 清空 `rewriteInstruction`。
- 清空 `rewriteTargetSegmentId`。
- 退出重写模式，切回 append。
- 保留 `appendInstruction`。

最后清空 `activeGenerationIntent`。

### `story.cancelled`

通用处理：

- `generationHandleRef.current = null`。
- 清空当前任务对应的临时正文。
- 设置状态消息为 `已取消生成`。
- 设置 `status` 为 `cancelled`。
- 清空 `activeGenerationIntent`。

append / create：

- 保留 `appendInstruction`。
- 保留 `initialStoryText`。

rewrite：

- 保留 `rewriteInstruction`。
- 保留 `rewriteTargetSegmentId`。
- 保持 rewrite 模式。
- 保留 `appendInstruction`。

### `story.error`

通用处理：

- `generationHandleRef.current = null`。
- 清空当前任务对应的临时正文。
- 设置 `status` 为 `failed`。
- 清空 `activeGenerationIntent`。

错误文案：

```ts
function getGenerationErrorMessage(
  error: StoryRealtimeGenerationError,
): string {
  if (error.code === "STORY_SEGMENT_NOT_REWRITABLE") {
    return "当前段落不可重写";
  }

  return error.message.length > 0 ? error.message : "生成失败，请稍后重试";
}
```

rewrite 错误处理：

- 保留 `rewriteInstruction`。
- 保留 `rewriteTargetSegmentId`。
- 保持 rewrite 模式。
- 保留 `appendInstruction`。

## 组件设计

### `StorylineReader`

新增 props：

```ts
interface StorylineReaderProps {
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
  canRewrite: boolean;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
}
```

职责：

- 渲染正式故事正文。
- 找出最新 generated segment。
- 仅对最新 generated segment 展示「重写」按钮。
- 重写按钮放在段落正文底部右侧。
- 点击重写按钮调用 `onStartRewrite(segment.id)`。
- 如果 `temporaryRewrite.targetSegmentId === segment.id`，在该段下方展示重写临时正文。
- 如果不是 rewrite 任务，续写临时正文仍展示在故事线末尾。

重写临时正文结构：

```text
重写中
<streamed rewrite text>
正在生成... / 正在记录角色摘要...
```

注意：

- `StorylineReader` 不负责校验 segment 是否可重写。
- `StorylineReader` 不维护草稿文本。
- `StorylineReader` 不发送实时请求。

### `StorylineComposer`

新增 props 建议：

```ts
type StorylineComposerMode = "append" | "rewrite";

interface StorylineComposerProps {
  mode: StorylineComposerMode;
  disabled: boolean;
  error?: string | undefined;
  isGenerating: boolean;
  modeHint?: string | undefined;
  onCancelGeneration: () => void;
  onCancelRewrite: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}
```

文案规则：

| 场景 | label | placeholder | 主按钮 |
| --- | --- | --- | --- |
| append | 续写指令 | 描述接下来要发生的主要情节和人物行动 | 生成续写 |
| rewrite | 重写指令 | 例如：不要转变场景，文风更加轻快，增加对气味的描写 | 生成重写 |
| generating | 当前模式 label | 当前模式 placeholder | 取消生成 |

重写模式提示：

```text
正在重写上一段
```

`取消重写` 显示条件：

- `mode === "rewrite"`。
- `isGenerating === false`。

点击 `取消重写`：

- 切回 append 模式。
- 清空 `rewriteTargetSegmentId`。
- 不清空 `rewriteInstruction` 也可以接受，但推荐清空重写错误信息。
- 不修改 `appendInstruction`。
- 不修改正式故事线。

表单 submit：

- 如果 `isGenerating`，调用 `onCancelGeneration()`。
- 否则调用 `onSubmit()`。

## 离开页面确认

`handleGoToStorylineList` 的草稿判断需要覆盖：

- `initialStoryText`。
- `appendInstruction`。
- `rewriteInstruction`。

进行中任务判断保持：

- `connecting`。
- `streaming`。
- `summarizing`。

如果用户确认离开且存在进行中任务：

- 调用 `generationHandleRef.current?.cancel()`。
- 导航到 `/storylines`。

草稿确认文案可以沿用：

```text
当前输入尚未提交，离开会丢失。确定返回故事列表吗？
```

生成中确认文案可以沿用：

```text
当前生成未完成，离开会取消本轮生成。确定返回故事列表吗？
```

## 滚动策略

create / append：

- 沿用现有 `isNearBottom()` 和 `shouldFollowScrollRef`。
- chunk、summary、completed 时按现有逻辑跟随底部。

rewrite：

- 点击重写按钮不自动滚动。
- 收到 `story.started` 不自动滚动。
- 收到 `story.chunk` 不自动滚动。
- 收到 `story.summary.started` 不自动滚动。
- 收到 `story.completed` 不自动滚动。

实现上可以在更新临时正文前根据 `activeGenerationIntent` 判断：

```ts
if (activeGenerationIntent?.type !== "rewrite") {
  shouldFollowScrollRef.current = isNearBottom();
}
```

并让自动滚动 effect 只响应 create / append 的临时正文变化。

## 错误与字段校验

字段错误建议拆分：

```ts
interface StorylineFieldErrors {
  initialStoryText?: string;
  appendInstruction?: string;
  rewriteInstruction?: string;
}
```

错误清理规则：

- 修改初始正文时清理 `initialStoryText` 错误。
- 修改续写指令时清理 `appendInstruction` 错误。
- 修改重写指令时清理 `rewriteInstruction` 错误。
- 切换模式不自动清空另一种模式的草稿。
- 重写成功后清空 `rewriteInstruction` 错误。
- 重写取消或失败后保留 `rewriteInstruction`，但可以保留或清空通用错误消息；推荐保留通用错误消息直到用户再次提交或修改输入。

通用错误消息：

- `STORY_SEGMENT_NOT_REWRITABLE`：`当前段落不可重写`。
- 其他错误：服务端 message 或 `生成失败，请稍后重试`。

## 验收标准

- 有 generated segment 的故事线，最新 generated segment 底部右侧显示「重写」按钮。
- 没有 generated segment 的故事线，不显示「重写」按钮。
- initial segment 不显示「重写」按钮。
- 非最新 generated segment 不显示「重写」按钮。
- 页面生成中或摘要记录中，不允许进入新的重写。
- 点击「重写」后，底部输入区切换为重写模式。
- 重写模式显示 `正在重写上一段`。
- 重写模式输入框标签为 `重写指令`。
- 重写模式主按钮为 `生成重写`。
- 空闲重写模式显示 `取消重写`。
- 重写生成中只显示 `取消生成`，不显示 `取消重写`。
- 续写草稿和重写草稿互不覆盖。
- 重写指令为空时展示 `请输入重写指令`。
- 提交重写后，发送 `mode: "rewrite"` payload。
- 重写流式正文展示在目标段下方。
- 重写流式生成时旧正式正文仍保留。
- 重写流式生成时页面不自动滚动。
- 重写摘要阶段展示 `正在记录角色摘要...`。
- 重写成功后，前端使用 `story.completed.storyline` 替换正式故事线。
- 重写成功后，清空重写指令并退出重写模式。
- 重写成功后，续写草稿保持不变。
- 重写取消后，临时重写正文消失。
- 重写取消后，旧正式正文不变。
- 重写取消后，重写指令保留，页面停留重写模式。
- 重写失败后，临时重写正文消失。
- 重写失败后，旧正式正文不变。
- 重写失败后，重写指令保留，页面停留重写模式。
- 收到 `STORY_SEGMENT_NOT_REWRITABLE` 后，通用消息区展示 `当前段落不可重写`。
- 离开页面确认覆盖重写草稿。

## 验证

本期前端实现完成后至少执行：

```bash
pnpm typecheck
pnpm lint
```

本期不强制新增 E2E。若后续实现过程中发现状态回归风险较高，再补充针对重写模式的 E2E 覆盖。
