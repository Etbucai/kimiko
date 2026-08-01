# 引入故事线角色摘要前端技术方案

## 背景

本文档对应 PRD：[summary.md](./summary.md)，并基于上一期故事线历史前端技术方案：[../004/history-fe.md](../004/history-fe.md)。

本期目标是在现有 StoryAgent 连续续写页面中增加“记录角色摘要”的中间阶段：正文流式生成结束后，服务端开始记录重要角色摘要；摘要记录成功后才发送 `story.completed`，前端再把临时正文替换为正式故事线快照。

前端不展示角色摘要内容，不提供摘要编辑入口，只透出“正在记录角色摘要...”状态。

## 已确认决策

- 本期前端仍只展示故事正文，不展示角色摘要内容。
- 角色摘要对前端不可见，不进入 `StorylineSnapshot`。
- 正文流式结束后，服务端发送 `story.summary.started`。
- 前端收到 `story.summary.started` 后进入 `summarizing` 状态。
- `summarizing` 状态下继续展示临时正文。
- `summarizing` 状态文案放在临时正文下方。
- 推荐状态文案为 `正在记录角色摘要...`。
- `summarizing` 状态下底部按钮继续显示 `取消生成`。
- 用户在 `summarizing` 状态点击取消，语义是取消整轮生成。
- 摘要失败使用 WebSocket 错误码 `STORY_SUMMARY_FAILED`。
- 摘要失败时前端展示通用生成失败文案，不暴露技术细节。
- `story.completed` 仍然是正式完成信号。
- `story.completed` 的 `storyline` 仍然是前端唯一正式快照来源。
- 本期不新增前端第三方依赖。

## 现有前端约束

- 前端使用 React、react-router、Tailwind CSS v4。
- 页面继续挂载在 `/`，继续由 `RequireAuth` 保护。
- API base URL 来自 `VITE_API_BASE_URL`。
- WebSocket base URL 继续从 `VITE_API_BASE_URL` 推导。
- 登录态保存在 `localStorage`，通过 `getStoredAuthSession()` 读取。
- 本地登录态失效时，页面跳转 `/login`。
- 共享契约使用 `@kimiko/schema` 的 zod schema 和类型。
- TypeScript 文件必须保持严格类型安全，避免 `any`。
- 非原始值 `useState`、`useRef` 必须显式标注泛型。
- 类型导入使用 `import type`。

## IDL Schema

005 只扩展 WebSocket 服务端事件和错误码。HTTP 恢复接口、`story.continue` 请求、`story.cancel` 请求和 `story.completed` 快照结构不变。

### 新增 Summary Started 事件

```ts
export const StorySummaryStartedServerEventSchema = z
  .object({
    type: z.literal("story.summary.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StorySummaryStartedServerEvent = z.infer<
  typeof StorySummaryStartedServerEventSchema
>;
```

说明：

- `story.summary.started` 表示正文流式 chunk 已结束，服务端开始记录角色摘要。
- 收到该事件后，前端必须停止展示“正在生成...”，改为展示“正在记录角色摘要...”。
- 该事件不是正式完成事件。
- 前端不能在该事件后把临时正文写入正式 `segments`。
- 前端仍应允许用户取消本轮生成。

### WebSocket 错误码扩展

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
]);
```

说明：

- `STORY_SUMMARY_FAILED` 表示正文已生成，但角色摘要记录失败。
- 前端收到该错误码时，按生成失败处理。
- 页面展示通用文案：`生成失败，请稍后重试`。
- 临时正文必须移除。
- 正式故事线快照保持不变。

### Server Event Union 更新

```ts
export const StoryRealtimeServerEventSchema = z.discriminatedUnion("type", [
  StoryStartedServerEventSchema,
  StoryChunkServerEventSchema,
  StorySummaryStartedServerEventSchema,
  StoryCompletedServerEventSchema,
  StoryCancelledServerEventSchema,
  StoryErrorServerEventSchema,
]);
```

事件顺序约束：

```text
story.started
-> story.chunk*
-> story.summary.started
-> story.completed | story.cancelled | story.error
```

说明：

- `story.chunk` 可以出现 0 次或多次。
- `story.summary.started` 最多出现 1 次。
- `story.summary.started` 之后不再发送 `story.chunk`。
- `story.completed` 只在正文、角色摘要和正式保存都成功后发送。
- `story.cancelled` 和 `story.error` 仍然是终态事件。

## 不变契约

### `story.completed`

`story.completed` 不新增角色摘要字段。

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

- `event.storyline` 仍是前端正式正文的唯一来源。
- 前端不从临时正文自行构造正式 segment。
- 前端不展示、缓存或解析角色摘要。

### `GET /storylines/recent`

恢复最近故事线接口不变。

```ts
export const GetRecentStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema.nullable(),
  })
  .strict();
```

说明：

- 前端恢复页面时不需要获取角色摘要。
- 角色摘要仅由服务端在后续生成时使用。

## 文件调整

调整以下文件：

- `packages/schema/src/index.ts`
  - 新增 `StorySummaryStartedServerEventSchema`。
  - 新增 `StorySummaryStartedServerEvent` 类型。
  - `StoryRealtimeServerEventSchema` union 增加 summary started 事件。
  - `StoryRealtimeErrorCodeSchema` 增加 `STORY_SUMMARY_FAILED`。
- `packages/web/src/story/storyRealtimeApi.ts`
  - `StoryRealtimeGenerationCallbacks` 增加 `onSummaryStarted`。
  - 收到 `story.summary.started` 后触发 `onSummaryStarted()`。
  - 该事件不关闭 socket，不 settle。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 页面状态增加 `summarizing`。
  - `isGenerating` 包含 `summarizing`。
  - 收到 `onSummaryStarted` 后进入 `summarizing`。
  - `summarizing` 下取消、失败、完成逻辑沿用生成中任务语义。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - 临时正文状态从 `isStreaming` 调整为更明确的阶段参数。
  - 在临时正文下方展示 `正在生成...` 或 `正在记录角色摘要...`。
- `packages/web/src/pages/story/StorylineComposer.tsx`
  - 可继续使用现有 `isGenerating` 控制按钮文案。
  - `summarizing` 下按钮仍显示 `取消生成`。

不需要调整：

- `packages/web/src/story/storylineApi.ts`
  - HTTP 恢复接口不变。
- `packages/web/src/pages/story/StoryInitialInput.tsx`
  - 初始故事正文输入规则不变。
- `packages/web/src/pages/story/StorylineRestoreError.tsx`
  - 恢复失败 UI 不变。

## Realtime API 设计

`storyRealtimeApi.ts` 的 callback 增加摘要阶段回调：

```ts
export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onSummaryStarted: () => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}
```

事件处理规则：

- 收到 `story.started` 后触发 `onStarted()`。
- 收到 `story.chunk` 后触发 `onChunk(delta, sequence)`。
- 收到 `story.summary.started` 后触发 `onSummaryStarted()`。
- 收到 `story.completed` 后触发 `onCompleted(event)`，然后关闭连接。
- 收到 `story.cancelled` 后触发 `onCancelled()`，然后关闭连接。
- 收到 `story.error` 后触发 `onError(event.message)`，然后关闭连接。
- 收到无法解析或不符合 schema 的消息时触发 `onError("生成失败，请稍后重试")`，然后关闭连接。

`onSummaryStarted()` 处理规则：

- 不清空临时正文。
- 不清空续写指令。
- 不关闭 WebSocket。
- 不更新正式 `storyline`。
- 只通知页面进入 `summarizing` 状态。

取消规则保持不变：

- `cancel()` 仍发送同一个 `requestId` 的 `story.cancel`。
- `summarizing` 状态下调用 `cancel()` 取消整轮生成。
- 收到 `story.cancelled` 后移除临时正文，保留输入内容。

## 页面状态模型

`StoryPage` 增加 `summarizing` 状态：

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

派生状态：

```ts
const isGenerating =
  status === "connecting" || status === "streaming" || status === "summarizing";

const temporaryTextStatus =
  status === "streaming"
    ? "streaming"
    : status === "summarizing"
      ? "summarizing"
      : null;
```

状态流转：

```text
loading
-> empty | ready | restoreFailed

empty | ready | completed | cancelled | failed
-> connecting
-> streaming
-> summarizing
-> completed

connecting | streaming | summarizing
-> cancelled | failed
```

事件映射：

- 提交成功进入 `connecting`。
- `story.started` 进入 `streaming`。
- `story.chunk` 保持或进入 `streaming`，追加 `temporaryGeneratedText`。
- `story.summary.started` 进入 `summarizing`。
- `story.completed` 进入 `completed`。
- `story.cancelled` 进入 `cancelled`。
- `story.error` 或连接异常进入 `failed`。

### Completed 处理

收到 `story.completed` 后：

- 用 `event.storyline` 替换正式 `storyline`。
- 清空 `temporaryGeneratedText`。
- 清空 `instruction`。
- 清空 `initialStoryText`。
- 清空 `generationStatusMessage`。
- 进入 `completed`。

### Cancelled 处理

收到 `story.cancelled` 后：

- 清空 `temporaryGeneratedText`。
- 保留 `instruction`。
- 保留 `initialStoryText`。
- 正式 `storyline` 不变。
- 展示 `已取消生成`。
- 进入 `cancelled`。

### Failed 处理

收到 `story.error` 或连接异常后：

- 清空 `temporaryGeneratedText`。
- 保留 `instruction`。
- 保留 `initialStoryText`。
- 正式 `storyline` 不变。
- 展示服务端返回文案；为空时展示 `生成失败，请稍后重试`。
- 进入 `failed`。

`STORY_SUMMARY_FAILED` 不需要前端特殊 UI 分支，按上述 failed 规则处理。

## UI 行为

### 临时正文状态

`StorylineReader` 和空态下的 `TemporaryGeneratedText` 都应支持临时正文阶段：

```ts
type TemporaryTextStatus = "streaming" | "summarizing" | null;
```

展示文案：

- `streaming`：`正在生成...`
- `summarizing`：`正在记录角色摘要...`
- `null`：不展示状态文案。

文案位置：

- 放在临时正文下方。
- 使用弱化小字号样式。
- 使用 `role="status"`，便于辅助技术感知状态变化。

### 底部输入区

- `summarizing` 状态下 textarea 保持 disabled。
- `summarizing` 状态下主按钮仍显示 `取消生成`。
- 点击主按钮调用 `handleCancel()`。
- 取消后恢复可输入状态，并保留原续写指令。

### 滚动策略

- `story.chunk` 期间沿用现有自动跟随策略。
- 收到 `story.summary.started` 时，如果用户仍接近页面底部，应滚动到临时正文状态文案可见。
- 如果用户已主动上滑，不强制滚动。
- `useEffect` 的依赖需要覆盖 `status` 或临时状态，以便 `summarizing` 文案出现后也能触发一次跟随。

### 最新生成元数据

- `summarizing` 阶段不更新最新生成元数据。
- 只有收到 `story.completed` 后，才使用 `event.storyline.latestGeneration` 展示最新模型、耗时、Token。
- 摘要失败时，旧的 `latestGeneration` 保持不变。

## 组件接口建议

### `StorylineReader`

```ts
type TemporaryTextStatus = "streaming" | "summarizing" | null;

interface StorylineReaderProps {
  temporaryTextStatus: TemporaryTextStatus;
  storyline: StorylineSnapshot;
  temporaryGeneratedText: string;
}
```

说明：

- 用 `temporaryTextStatus` 替代 `isStreaming`，避免后续继续增加布尔参数。
- 当 `temporaryGeneratedText.length === 0` 时，不展示临时正文区域。

### `TemporaryGeneratedText`

空态下的临时正文组件也使用同一阶段类型：

```ts
interface TemporaryGeneratedTextProps {
  status: TemporaryTextStatus;
  text: string;
}
```

说明：

- `status === "streaming"` 时展示 `正在生成...`。
- `status === "summarizing"` 时展示 `正在记录角色摘要...`。
- `status === null` 时不展示状态文案。

### `StorylineComposer`

当前接口可保持不变：

```ts
interface StorylineComposerProps {
  disabled: boolean;
  error?: string | undefined;
  isGenerating: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}
```

说明：

- `isGenerating` 覆盖 `connecting`、`streaming`、`summarizing`。
- `isGenerating === true` 时按钮显示 `取消生成`。

## 验收标准

- 收到 `story.summary.started` 后，页面进入 `summarizing` 状态。
- `summarizing` 状态下临时正文仍展示在正文尾部。
- `summarizing` 状态下临时正文下方展示 `正在记录角色摘要...`。
- `summarizing` 状态下底部按钮显示 `取消生成`。
- `summarizing` 状态下点击取消会发送 `story.cancel`。
- 收到 `story.cancelled` 后，临时正文被移除，正式故事线保持不变。
- 收到 `story.completed` 后，前端使用 `event.storyline` 替换正式快照。
- 收到 `story.completed` 后，临时正文被清空。
- 收到 `STORY_SUMMARY_FAILED` 对应的 `story.error` 后，页面进入失败状态。
- 摘要失败后，临时正文被移除，正式故事线保持不变。
- 摘要失败后，页面不展示“角色摘要失败”等技术细节。
- `GET /storylines/recent` 不返回角色摘要，页面恢复逻辑不受影响。
- TypeScript 类型检查通过，不引入 `any`。
- 非原始值 `useState`、`useRef` 保持显式泛型标注。

## 实施顺序

1. 更新 `packages/schema/src/index.ts`，加入 `story.summary.started` 和 `STORY_SUMMARY_FAILED`。
2. 更新 `storyRealtimeApi.ts`，解析并转发 `story.summary.started`。
3. 更新 `StoryPage.tsx`，加入 `summarizing` 状态和状态流转。
4. 更新 `StorylineReader.tsx` 和空态临时正文展示，支持 `正在记录角色摘要...`。
5. 保持 `StorylineComposer.tsx` 现有交互，只让 `isGenerating` 覆盖 `summarizing`。
6. 运行前端 typecheck、lint 和 workspace build。
