# LLM 后台生成与手动取消前端技术方案

## 背景

本文档对应总方案：[llm-background-generation.md](./llm-background-generation.md)。

010 的产品目标是：用户手动取消才停止 LLM 生成。前端掉线、刷新、退出故事页或跳转到调试页时，服务端继续跑生成任务。前端需要把“关闭页面连接”和“取消生成”拆开，并在用户重新进入已有故事线详情页时恢复后台任务状态。

当前前端已经支持 WebSocket 流式生成、续写、重写、互动、context 更新阶段和取消按钮。但现有页面行为仍有两处与目标冲突：

- `handleGoToStorylineList` 在生成中返回列表时会确认并调用 `generationHandle.cancel()`。
- `handleOpenContextDebug` 在生成中打开调试页时会确认并调用 `generationHandle.cancel()`。

本期前端目标是移除这些隐式取消语义，保留显式取消按钮，并新增基于 REST 状态接口的后台任务恢复能力。

## 已确认决策

- 新增独立前端技术文档：`docs/010/llm-background-generation-fe.md`。
- 前端新增页面状态承接服务端 phase：
  - `preparing`
  - `saving`
- 后台任务 running 时，详情页保留旧故事正文，不展示断线期间错过的临时正文。
- 后台任务 running 时，在现有 `generationStatusMessage` 区域显示阶段文案。
- 后台任务 running 时，取消入口复用现有 FAB 取消按钮。
- 首页 `/` 的 recent 故事页也要恢复后台任务状态。
- 后台状态轮询每 2 秒一次。
- 状态轮询临时失败时，保守继续轮询，不立即恢复可编辑状态。
- 后台任务 completed 后，前端刷新故事线并 toast “生成已完成”。
- completed 后刷新故事线失败时，提示失败并保留可恢复状态，不吞掉完成事件。
- 后台任务 failed 后，toast 错误原因，并恢复可编辑状态。
- 后台任务 cancelled 后，恢复可编辑状态。
- `/storylines/new` 的 create 生成中离开页面时静默离开，不再提示取消；服务端后台继续跑。
- create 退出后不支持运行中状态找回，也不支持退出后取消。
- 用户点击 REST 取消后台任务后，不新增 `cancelling` 状态；等待接口返回终态。
- 后台 running 时，页面里尚未提交的输入草稿照常保留，只禁用提交。
- 前端状态 / 取消 API client 的 result union 区分 `notFound`。
- 前端读到终态后停止轮询；不新增 ack 清理接口。
- 故事列表页暂不展示后台生成状态。

## 非目标

- 不补齐断线期间的 `story.chunk`。
- 不让多个页面同时同步流式正文。
- 不在故事列表页显示生成中标记。
- 不在列表页提供取消后台生成入口。
- 不为 create 任务新增找回页面或用户级 active create 查询。
- 不新增复杂任务面板。
- 不新增服务端终态 ack 接口。
- 不改变现有实时生成的流式体验。

## 现有前端约束

- 前端使用 React + React Router。
- 样式使用 Tailwind CSS v4。
- Toast 使用 `sonner`。
- HTTP API client 集中在 `packages/web/src/story/storylineApi.ts`。
- WebSocket client 集中在 `packages/web/src/story/storyRealtimeApi.ts`。
- 故事页状态集中在 `packages/web/src/pages/story/StoryPage.tsx`。
- 故事正文展示集中在 `StorylineReader`。
- 取消入口当前有：
  - `StorylineComposer` 提交按钮在生成中显示“取消生成”。
  - `StoryActionFab` 在生成中显示 FAB 停止按钮。
- 共享契约来自 `@kimiko/schema`。
- TypeScript 必须保持严格类型安全：
  - 类型导入使用 `import type`。
  - 非原始值 `useState`、`useRef` 必须显式标注泛型。

## 共享契约影响

前端从 `@kimiko/schema` 新增引入：

```ts
import type {
  CancelStoryGenerationResponse,
  StoryGenerationPhase,
  StoryGenerationStatusResponse,
} from "@kimiko/schema";
import {
  CancelStoryGenerationResponseSchema,
  StoryGenerationStatusResponseSchema,
} from "@kimiko/schema";
```

具体类型名称以后端实际落地为准，但前端只消费最终共享契约，不自行复制 schema。

## API Client 设计

在 `packages/web/src/story/storylineApi.ts` 新增两个 API。

### `getStoryGenerationStatus`

```ts
export type GetStoryGenerationStatusResult =
  | Readonly<{
      status: "success";
      task: StoryGenerationStatusResponse["task"];
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStoryGenerationStatus(
  storylineId: StorylineId,
): Promise<GetStoryGenerationStatusResult>;
```

请求：

```http
GET /storylines/:storylineId/generation/status
```

行为：

- `401`：清理 auth session，返回 `authRequired`。
- `404`：返回 `notFound`，与 `getStoryline` 保持一致。
- 非 `2xx`：返回 `failed`。
- 响应 schema 校验失败：返回 `failed`。
- 成功：返回 `task`，可为 `null`。

### `cancelStoryGeneration`

```ts
export type CancelStoryGenerationResult =
  | Readonly<{
      status: "success";
      cancelled: boolean;
      task: CancelStoryGenerationResponse["task"];
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function cancelStoryGeneration(
  storylineId: StorylineId,
): Promise<CancelStoryGenerationResult>;
```

请求：

```http
POST /storylines/:storylineId/generation/cancel
```

行为：

- 无活跃任务时也可能成功返回 `cancelled: false`。
- 如果返回 `task.status === "completed"`，前端按完成处理，刷新故事线。
- 如果返回 `task.status === "cancelled"` 或 `task === null`，前端恢复可编辑状态。
- 如果取消接口临时失败，前端 toast 错误，并保持后台 running 状态，下一轮轮询继续确认真实状态。

## 页面状态模型

`StorylinePageStatus` 扩展为：

```ts
type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "preparing"
  | "streaming"
  | "updatingContext"
  | "saving"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";
```

`isGenerating` 调整为：

```ts
const isGenerating =
  status === "connecting" ||
  status === "preparing" ||
  status === "streaming" ||
  status === "updatingContext" ||
  status === "saving";
```

`TemporaryTextStatus` 仍只用于已有实时临时正文：

```ts
type TemporaryTextStatus = "streaming" | "updatingContext" | null;
```

原因：

- `preparing` 时还没有临时正文。
- `saving` 时临时正文已经来自实时连接时才存在；后台恢复场景不展示临时正文。
- 后台恢复只通过 `generationStatusMessage` 展示阶段文案。

建议新增后台任务状态：

```ts
type BackgroundGenerationTask = NonNullable<
  StoryGenerationStatusResponse["task"]
>;

const [backgroundTask, setBackgroundTask] =
  useState<BackgroundGenerationTask | null>(null);
```

`backgroundTask !== null && backgroundTask.status === "running"` 表示当前页面正在展示后台任务状态。

## Phase 到 UI 的映射

```ts
function getStatusFromGenerationPhase(
  phase: StoryGenerationPhase,
): StorylinePageStatus {
  switch (phase) {
    case "preparing":
      return "preparing";
    case "streaming":
      return "streaming";
    case "updatingContext":
      return "updatingContext";
    case "saving":
      return "saving";
  }
}
```

后台恢复阶段文案使用“后台”字样：

| phase             | 文案                      |
| ----------------- | ------------------------- |
| `preparing`       | 准备后台生成中...         |
| `streaming`       | 正在后台生成正文...       |
| `updatingContext` | 正在后台更新故事上下文... |
| `saving`          | 正在保存后台生成结果...   |

实时连接仍使用现有临时正文文案：

- `streaming`：正在生成...
- `updatingContext`：正在更新故事上下文...

这样用户可以区分：

- 当前页面仍在接收实时正文。
- 页面是重新进入后看到后台任务状态。

## 恢复流程

`restoreStoryline` 成功获取故事线后，新增后台状态检查。

### `mode === "new"`

不查后台状态：

- 维持 `empty`。
- create 任务退出后不找回。

### `mode === "detail"`

流程：

1. 调用 `getStoryline(storylineId)`。
2. 成功后设置 `storyline`。
3. 调用 `getStoryGenerationStatus(storyline.id)`。
4. 根据状态结果更新页面。

### `mode === "recent"`

流程：

1. 调用 `getRecentStoryline()`。
2. 如果 `storyline === null`，进入 `empty`。
3. 如果存在最近故事线，调用 `getStoryGenerationStatus(storyline.id)`。
4. 根据状态结果更新页面。

### 状态处理

`task === null`：

- `setBackgroundTask(null)`。
- `setStatus("ready")`。

`task.status === "running"`：

- `setBackgroundTask(task)`。
- 清空临时正文：
  - `temporaryAppendText = ""`
  - `temporaryDialogueText = ""`
  - `temporaryRewrite = null`
- 不清空用户输入草稿。
- `setActiveGenerationIntent(null)`。
- `setGenerationStatusMessage(getBackgroundPhaseMessage(task.phase))`。
- `setStatus(getStatusFromGenerationPhase(task.phase))`。
- 启动 2 秒轮询。

`task.status === "completed"`：

- 停止轮询。
- 调用刷新故事线逻辑。
- 成功后：
  - 更新 `storyline`。
  - `setBackgroundTask(null)`。
  - `setGenerationStatusMessage("")`。
  - `setStatus("completed")`。
  - toast “生成已完成”。
- 刷新失败：
  - toast “生成已完成，但刷新故事线失败，请重试”。
  - 保留 `backgroundTask` 或终态提示，提供后续恢复机会。

`task.status === "failed"`：

- 停止轮询。
- `setBackgroundTask(null)`。
- `setStatus("failed")`。
- toast `task.message` 或通用失败文案。
- 不清空用户输入草稿。

`task.status === "cancelled"`：

- 停止轮询。
- `setBackgroundTask(null)`。
- `setStatus("cancelled")`。
- toast “已取消生成”。
- 不清空用户输入草稿。

## 轮询设计

新增轮询 timer ref：

```ts
const backgroundPollTimerRef = useRef<number | null>(null);
const backgroundPollFailureNotifiedRef = useRef(false);
```

规则：

- 只在已有故事线 `task.status === "running"` 时轮询。
- 间隔 2 秒。
- 组件卸载时清理 timer。
- 切换故事线或重新 restore 时清理旧 timer。
- 读到终态后停止轮询。
- 不向服务端发送 ack。

轮询失败策略：

- 第一次失败可 toast “后台生成状态暂时不可用，稍后自动重试”。
- 保持当前 running 状态。
- 不恢复提交入口。
- 后续失败可以静默，避免 toast 风暴。
- 下一轮继续轮询。

## 取消流程

`handleCancel` 改成区分实时任务和后台任务。

```ts
function handleCancel(): void {
  if (generationHandleRef.current !== null) {
    generationHandleRef.current.cancel();
    return;
  }

  if (
    storyline !== null &&
    backgroundTask !== null &&
    backgroundTask.status === "running"
  ) {
    void cancelBackgroundGeneration(storyline.id);
  }
}
```

`cancelBackgroundGeneration`：

1. 调用 `cancelStoryGeneration(storylineId)`。
2. `authRequired` 时跳转登录。
3. `notFound` 时进入恢复失败页。
4. `failed` 时 toast 错误，继续轮询。
5. `success` 时按返回 `task` 处理：
   - `completed`：刷新故事线。
   - `cancelled` 或 `task === null`：恢复可编辑状态。
   - `running`：保持当前状态，等待下一轮轮询。

不新增 `cancelling` 状态。按钮点击后维持当前 running 文案，直到接口或轮询返回真实终态。

## 离开页面行为

### 返回列表

`handleGoToStorylineList` 调整：

- 如果 `isGenerating`：
  - 不弹出“离开会取消本轮生成”确认。
  - 不调用 `cancel()`。
  - 调用 `generationHandleRef.current?.close()`。
  - 直接 `navigate("/storylines")`。
- 如果不是生成中，仍保留未提交草稿的离开确认。

### 打开 context 调试页

`handleOpenContextDebug` 调整：

- 如果 `isGenerating`：
  - 不弹出“离开会取消本轮生成”确认。
  - 不调用 `cancel()`。
  - 调用 `generationHandleRef.current?.close()`。
  - 直接跳转 context 调试页。
- 如果不是生成中，仍保留未提交草稿的离开确认。

### 组件卸载

现有卸载逻辑已经调用：

```ts
generationHandleRef.current?.close();
```

`close()` 继续只代表关闭 WebSocket 连接，不代表取消生成。文档要求 `storyRealtimeApi.close()` 保持这个语义。

### create 页面离开

`/storylines/new` 在 create 生成中离开时：

- 静默离开。
- 关闭 WebSocket。
- 不取消服务端任务。
- 不提供运行中找回。
- 用户可稍后从 recent / list 找到完成的新故事。

## WebSocket Client 调整

`packages/web/src/story/storyRealtimeApi.ts` 保持两个动作语义清晰：

```ts
interface StoryRealtimeGenerationHandle {
  cancel: () => void; // 用户明确取消
  close: () => void; // 页面断开连接
}
```

需要调整 close/error 处理认知：

- `close()` 设置 `isClosedByClient = true` 后关闭 socket。
- close 不触发 `onCancelled`。
- 网络异常导致 socket close 时，如果不是用户主动 close，仍可按现有逻辑触发错误；服务端会继续后台跑，但当前页面无法确认任务状态。
- 后续由重新进入页面后的 REST status 负责恢复。

本期不要求 WebSocket 自动降级为 REST 轮询；降级只发生在页面重新 restore 后。

## 组件影响

### `StoryPage`

主要改动：

- 扩展 `StorylinePageStatus`。
- 新增 `backgroundTask` 状态。
- 新增后台状态查询、轮询、取消逻辑。
- `restoreStoryline` 成功后接入 `getStoryGenerationStatus`。
- `handleCancel` 支持 REST cancel。
- `handleGoToStorylineList` 和 `handleOpenContextDebug` 移除生成中取消逻辑。
- `isGenerating` 纳入 `preparing` / `saving`。
- 后台 running 时保留旧故事正文，只展示状态条。

### `StorylineReader`

原则上不需要展示后台临时正文。

仅当类型联动需要时，保持 `temporaryTextStatus` 为：

```ts
"streaming" | "updatingContext" | null;
```

不把 `preparing` / `saving` 传入 `TemporaryStatus`。

### `StoryActionFab`

无需新增 UI。

后台 running 时，`StoryPage.isGenerating === true`，FAB 自动显示停止按钮。按钮点击走 `handleCancel`，由 `handleCancel` 决定使用 WebSocket cancel 还是 REST cancel。

### `StorylineComposer`

create 页面仍可在原页面上取消实时任务。

如果用户离开 create 页面，则关闭连接但不取消服务端任务。重新进入 `/storylines/new` 不恢复 create 状态。

### `StorylineListPage`

不调整。

列表页暂不展示后台生成状态。

## 文件调整

需要调整：

- `packages/schema/src/index.ts`
  - 消费新增生成状态 / 取消响应契约。
- `packages/web/src/story/storylineApi.ts`
  - 新增 `getStoryGenerationStatus`。
  - 新增 `cancelStoryGeneration`。
  - 新增默认错误文案。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 扩展页面状态。
  - 接入后台任务恢复与轮询。
  - 接入 REST 取消。
  - 移除生成中离开页面的取消确认。
- `packages/web/src/story/storyRealtimeApi.ts`
  - 确认 `close()` 只关闭连接。
  - 保持 `cancel()` 才发送 `story.cancel`。

通常不需要调整：

- `packages/web/src/pages/story/StorylineReader.tsx`
- `packages/web/src/pages/story/StoryActionFab.tsx`
- `packages/web/src/pages/story/StorylineComposer.tsx`
- `packages/web/src/pages/story/StorylineListPage.tsx`
- `packages/web/src/App.tsx`

## 测试与验证

### 手动验证路径

- 在已有故事线生成中点击返回列表，服务端继续生成，列表页不显示生成状态。
- 回到该故事线详情页，看到后台阶段状态和 FAB 取消按钮。
- 后台生成完成后，页面刷新故事线并 toast “生成已完成”。
- 后台生成失败后，页面 toast 错误，恢复可编辑状态。
- 后台生成中点击 FAB，调用 REST cancel，页面恢复可编辑状态。
- 原页面不离开时，流式正文展示不退化。
- 新建故事生成中离开页面，服务端继续生成；之后可在 recent / list 找到完成的新故事。
- 状态轮询接口临时失败时，页面不解锁提交入口。

### 自动验证命令

- `pnpm --filter @kimiko/web typecheck`
- `pnpm --filter @kimiko/web lint`
- `pnpm --filter @kimiko/web build`

如补充前端测试，优先覆盖：

- `storylineApi` 对 status / cancel 响应的 union 映射。
- `StoryPage` 在 running status 下禁用提交并显示后台文案。
- `StoryPage` 在 completed status 下刷新故事线。

## 验收标准

- 用户离开页面不会触发前端取消生成。
- 用户明确点击取消时才触发 WebSocket cancel 或 REST cancel。
- 已有故事线重新进入页面后可看到后台生成阶段。
- 后台 running 时页面保留旧故事正文，不展示缺失的流式正文。
- 后台 running 时 FAB 可取消任务。
- completed / failed / cancelled 终态能正确停止轮询并更新 UI。
- recent 首页和详情页都支持后台状态恢复。
- create 页面退出后不恢复运行中状态。
