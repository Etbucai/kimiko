# LLM 后台生成与手动取消技术方案

## 背景

本文档对应 `010` 主题：用户手动取消才停止 LLM 生成。

当前故事生成通过 WebSocket `/realtime` 启动，并把生成任务绑定在单个 WebSocket 连接上。`RealtimeGateway.cleanupClient` 会在连接关闭时调用当前任务的 `AbortController.abort()`。这导致前端掉线、刷新、退出故事页或跳转到调试页时，服务端会停止本轮 LLM 生成。

新的目标是把“连接生命周期”和“生成任务生命周期”拆开：前端连接断开只表示当前页面不再接收流式事件，不代表用户要取消生成。只有用户明确点击取消，服务端才尝试停止正在运行的 LLM 任务。

## 已确认决策

- 后台任务状态保存在服务端内存中，不落库。
- 服务端进程重启后，内存任务状态丢失可接受。
- WebSocket 仍负责启动生成和原页面实时流式展示。
- 启动生成的页面没有离开时，保留现有 `chunk` / `context.started` / `completed` 体验。
- WebSocket 断开时只解绑连接，不再 abort 任务。
- 已有故事线支持用户重新进入详情页后恢复后台任务状态。
- 前端重进详情页后只显示阶段级状态，不补齐断线期间错过的流式 chunk。
- 前端发现已有后台任务后，每 2 秒轮询状态。
- 任务完成后，前端刷新故事线并轻提示“生成已完成”。
- 任务失败后，前端 toast 错误原因并恢复可编辑状态。
- 后台任务取消按 `storylineId` 定位，不依赖旧 `requestId`。
- 对没有活跃任务的故事线执行取消时，接口幂等成功，不向用户报错。
- 取消是 best-effort：
  - LLM 正文生成或 context 更新阶段仍应尽快 abort。
  - 如果任务已经保存成功，则最终状态按 `completed` 处理，不做回滚。
- 新建故事 `create` 是例外：
  - 前端断线后服务端仍继续跑到完成。
  - 不支持退出后找回运行中状态。
  - 不支持退出后按 `storylineId` 取消，因为此时还没有 `storylineId`。
  - 完成后用户可通过 recent / list 找到新故事。
- 故事列表页暂不显示后台生成状态，也不提供列表级取消入口。
- 终态任务状态在内存中保留 10 分钟，然后自动清理。
- 服务端新增结构化日志，覆盖后台任务生命周期。

## 非目标

- 不引入持久化任务队列。
- 不支持服务端重启后恢复仍在运行的 LLM 请求。
- 不缓存或补发断线期间的流式 chunk。
- 不让多个页面同时订阅同一个任务的流式正文。
- 不在故事列表页展示“生成中”标记。
- 不为 `create` 任务设计找回或取消能力。
- 不做已保存 segment / context 的强制回滚。
- 不改变正文生成成功后 context 更新和保存的原子性要求。

## 现状约束

- 服务端使用 NestJS。
- WebSocket 网关位于 `packages/server/src/realtime/realtime.gateway.ts`。
- 故事生成编排位于 `StorylineGenerationService.streamContinueStoryline`。
- 生成内部通过 `AbortSignal` 传递取消信号。
- `StorylineLockService` 已提供：
  - `create:${userId}` 用户级新建锁。
  - `storyline:${storylineId}` 故事线级生成锁。
- 前端 WebSocket 客户端位于 `packages/web/src/story/storyRealtimeApi.ts`。
- 前端故事页位于 `packages/web/src/pages/story/StoryPage.tsx`。
- REST API client 位于 `packages/web/src/story/storylineApi.ts`。
- 共享契约集中在 `@kimiko/schema`，使用 Zod 作为 SSOT。

## 设计总览

新增一个服务端内存任务注册表，作为生成任务的所有者。

```text
RealtimeGateway
  - 校验 WebSocket 用户身份
  - 接收 story.continue，创建后台任务
  - 当前连接存在时转发流式事件
  - 连接断开时只 detach subscriber

StoryGenerationTaskRegistry
  - 保存活跃任务和短期终态
  - 持有 AbortController
  - 记录阶段、错误、生成结果
  - 支持按 storylineId 查询和取消
  - 负责 10 分钟 TTL 清理

StorylineController
  - GET /storylines/:storylineId/generation/status
  - POST /storylines/:storylineId/generation/cancel

StorylineGenerationService
  - 保持现有流式生成编排
  - 在关键阶段向 registry 上报 phase
```

核心变化：

1. `AbortController` 不再属于某个 WebSocket client state，而属于后台任务。
2. WebSocket client state 只保存当前连接正在观察的任务引用。
3. 连接关闭只移除 observer，不取消任务。
4. 用户取消通过 REST 或原 WebSocket cancel 消息触发 registry cancel。

## 后台任务模型

### 任务键

已有故事线任务使用：

```text
userId + storylineId
```

同一故事线同时只能有一个活跃任务，继续复用 `StorylineLockService` 的故事线锁。

`create` 任务使用：

```text
userId + requestId
```

但 `create` 不提供恢复状态和退出后取消能力。

### 任务状态

共享契约新增阶段枚举：

```ts
export const StoryGenerationPhaseSchema = z.enum([
  "preparing",
  "streaming",
  "updatingContext",
  "saving",
]);

export const StoryGenerationTaskStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const StoryGenerationModeSchema = z.enum([
  "create",
  "append",
  "rewrite",
  "dialogue",
]);
```

`phase` 只在 `running` 状态下必填。

建议状态响应：

```ts
export const StoryGenerationStatusResponseSchema = z
  .object({
    task: z
      .object({
        status: StoryGenerationTaskStatusSchema,
        phase: StoryGenerationPhaseSchema.optional(),
        mode: StoryGenerationModeSchema,
        requestId: StoryRealtimeRequestIdSchema,
        storylineId: StorylineIdSchema.optional(),
        generatedSegmentId: StorylineSegmentIdSchema.optional(),
        errorCode: StoryRealtimeErrorCodeSchema.optional(),
        message: z.string().min(1).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
```

说明：

- `task: null` 表示当前故事线没有可见的活跃任务或短期终态。
- `status: "running"` 表示服务端仍在执行。
- `status: "completed"` 表示后台任务已完成，前端应刷新故事线。
- `status: "failed"` 表示后台任务失败，前端应提示 `message`。
- `status: "cancelled"` 表示任务已取消。

## 服务端接口

### 查询生成状态

```http
GET /storylines/:storylineId/generation/status
Authorization: Bearer <accessToken>
```

行为：

- 校验当前用户拥有该故事线。
- 查询内存 registry 中 `userId + storylineId` 对应任务。
- 返回活跃任务或 10 分钟内的终态任务。
- 没有任务时返回 `{ "task": null }`。
- 故事线不存在时返回 404。

### 取消生成

```http
POST /storylines/:storylineId/generation/cancel
Authorization: Bearer <accessToken>
```

建议响应：

```ts
export const CancelStoryGenerationResponseSchema = z
  .object({
    cancelled: z.boolean(),
    task: StoryGenerationStatusResponseSchema.shape.task,
  })
  .strict();
```

行为：

- 校验当前用户拥有该故事线。
- 如果没有活跃任务，返回 `cancelled: false`，不报错。
- 如果有活跃任务：
  - 调用任务的 `AbortController.abort()`。
  - 将任务标记为 `cancelled`。
  - 向当前仍连接的 observer 发送 `story.cancelled`。
  - 返回 `cancelled: true`。
- 如果任务已经完成保存，则返回终态 `completed`，不回滚。

## WebSocket 协议调整

现有客户端消息保持：

```text
story.continue
story.cancel
```

现有服务端事件保持：

```text
story.started
story.chunk
story.context.started
story.completed
story.cancelled
story.error
```

变化点：

- `story.continue` 创建 registry task。
- `story.cancel` 仍支持，用于原页面上的取消按钮。
- `story.cancel` 内部改为通过 registry 取消任务。
- WebSocket close 不再触发 abort。
- close 后，任务继续执行；由于没有 observer，后续 chunk 不再发送给该页面。

## 阶段映射

`StorylineGenerationService` 需要在关键阶段上报 phase：

| 服务端阶段                        | 对外 phase        | 前端表现               |
| --------------------------------- | ----------------- | ---------------------- |
| 查询故事线、拿锁、构造 LLM 上下文 | `preparing`       | 正在准备生成           |
| writer LLM 流式生成正文           | `streaming`       | 正在生成正文           |
| context patch 生成与 repair       | `updatingContext` | 正在更新故事上下文     |
| segment 与 context 事务保存       | `saving`          | 正在保存生成结果       |
| 保存完成                          | `completed`       | 刷新故事线并轻提示     |
| 用户取消                          | `cancelled`       | 恢复可编辑状态         |
| 异常失败                          | `failed`          | toast 错误并恢复可编辑 |

`create` 模式虽然也可以在 registry 内记录阶段，但不通过 `storylineId` 暴露给前端找回。

## 前端行为

### 原页面生成

用户在故事页点击生成后：

1. 前端照常打开 WebSocket。
2. 收到 `story.chunk` 时继续展示临时正文。
3. 收到 `story.context.started` 时进入 `updatingContext`。
4. 收到 `story.completed` 时更新 `storyline`。
5. 用户点击取消时照常发送 `story.cancel`。

### 离开页面

生成中点击返回列表或打开 context 调试页：

- 不再弹出“离开会取消本轮生成”确认。
- 不调用 `generationHandle.cancel()`。
- 只调用 `generationHandle.close()` 或随组件卸载关闭 WebSocket。
- 服务端继续后台生成。

`StoryPage` 中相关文案需要移除或调整，避免误导用户以为离开会取消。

### 重新进入已有故事线详情页

恢复故事线后：

1. 调用 `GET /storylines/:storylineId/generation/status`。
2. 如果 `task` 为 `running`：
   - 根据 `phase` 设置页面状态。
   - 不展示断线期间错过的临时正文。
   - 禁用新的生成入口。
   - 显示取消按钮。
   - 每 2 秒轮询状态。
3. 如果 `task.status === "completed"`：
   - 重新拉取故事线详情。
   - toast “生成已完成”。
4. 如果 `task.status === "failed"`：
   - toast `task.message` 或通用失败文案。
   - 恢复可编辑状态。
5. 如果 `task.status === "cancelled"`：
   - 恢复可编辑状态。
6. 如果 `task === null`：
   - 保持普通 ready 状态。

### 取消后台任务

如果当前页面是通过状态接口恢复到后台运行状态，取消按钮调用：

```http
POST /storylines/:storylineId/generation/cancel
```

不依赖旧 WebSocket `requestId`。

## 日志要求

服务端新增结构化日志，至少覆盖：

```text
story_generation_task_started
story_generation_task_phase_changed
story_generation_task_observer_detached
story_generation_task_cancel_requested
story_generation_task_terminal
story_generation_task_ttl_cleanup
```

日志字段建议：

- `requestId`
- `userId`
- `storylineId`
- `mode`
- `phase`
- `status`
- `errorCode`
- `generatedSegmentId`
- `elapsedMs`
- `hadObserver`

继续遵守服务端日志规则：异常链路必须记录日志，不记录敏感内容或过大的文本内容。

## 文件调整

### 共享契约

- `packages/schema/src/index.ts`
  - 新增 `StoryGenerationPhaseSchema`。
  - 新增 `StoryGenerationTaskStatusSchema`。
  - 新增 `StoryGenerationStatusResponseSchema`。
  - 新增 `CancelStoryGenerationResponseSchema`。

### 服务端

- `packages/server/src/realtime/realtime.types.ts`
  - 调整 `ActiveRealtimeTask`，不再直接持有连接私有的 `AbortController`。
- `packages/server/src/realtime/realtime.gateway.ts`
  - WebSocket 断开时不再 abort。
  - `story.continue` 创建后台任务。
  - `story.cancel` 通过 task registry 取消。
  - 当前连接存在时继续发送实时事件。
- `packages/server/src/realtime/story-generation-task-registry.ts`
  - 新增内存任务注册表。
  - 管理 active task、terminal task、observer、TTL 清理和取消。
- `packages/server/src/storyline/storyline.controller.ts`
  - 新增状态查询接口。
  - 新增取消接口。
- `packages/server/src/storyline/storyline.module.ts`
  - 注册并导出 task registry。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - 在关键阶段上报 phase。
  - 保存前后区分 `saving` 和 `completed`。

### 前端

- `packages/web/src/story/storylineApi.ts`
  - 新增 `getStoryGenerationStatus`。
  - 新增 `cancelStoryGeneration`。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 恢复故事线后查询后台生成状态。
  - running 时每 2 秒轮询。
  - 后台 running 时禁用提交，保留取消入口。
  - 离开页面时只 close WebSocket，不 cancel。
  - 返回列表 / 打开调试页时移除“离开会取消”确认。
- `packages/web/src/story/storyRealtimeApi.ts`
  - `close()` 只关闭连接，不承担取消语义。
  - 保持 `cancel()` 显式发送 `story.cancel`。

## 测试计划

### 服务端 E2E

在 `packages/server/test/realtime.e2e-spec.ts` 增加覆盖：

- WebSocket 断开后，LLM 生成继续执行并最终落库。
- 已有故事线后台生成中，`GET /generation/status` 返回 `running + phase`。
- 后台任务完成后，状态接口短期返回 `completed + generatedSegmentId`。
- `POST /generation/cancel` 能取消已有故事线后台任务。
- 无活跃任务时取消接口幂等成功。
- 原 WebSocket 连接未断开时，实时 chunk 体验保持不变。
- `create` 断线后继续完成，但不通过 storyline status 找回。

### 前端验证

- `pnpm --filter @kimiko/web typecheck`
- `pnpm --filter @kimiko/web lint`
- `pnpm --filter @kimiko/web build`

### 服务端验证

- `pnpm --filter @kimiko/server typecheck`
- `pnpm --filter @kimiko/server lint`
- `pnpm --filter @kimiko/server test`
- `pnpm --filter @kimiko/server test:e2e`

## 风险与取舍

### 内存状态丢失

服务端重启后无法查询后台任务状态。这符合本地实验项目约束。LLM 请求本身也无法跨进程恢复，落库队列不是本期目标。

### 断线期间没有临时正文

用户重新进入页面时不会看到已生成但尚未保存的正文片段。这样避免缓存 chunk 和多 subscriber 协议，复杂度更低。最终保存成功后刷新故事线即可看到结果。

### create 无法退出后取消

`create` 提交时还没有 `storylineId`，若要支持找回需要额外引入用户级 active create 查询或预创建空故事线。本期选择不做，保持实现集中在已有故事线后台任务。

### best-effort 取消

取消无法保证撤销已经提交成功的保存结果。强制回滚会涉及 append、rewrite、dialogue 和 context 回滚规则，复杂度高且容易引入一致性问题。本期以“保存完成即完成”为准。

## 验收标准

- 前端掉线、刷新或退出已有故事线详情页后，服务端不会自动 abort 本轮生成。
- 用户重新进入已有故事线详情页时，可以看到后台生成阶段。
- 用户可在重新进入详情页后手动取消后台任务。
- 用户未取消时，后台任务最终成功后会正常落库。
- 原页面未离开时，实时流式生成体验不退化。
- 生成失败、取消、完成的终态可在 10 分钟内被状态接口查询到。
- 故事列表页不需要展示后台生成状态。
- 新建故事断线后继续跑，但不要求展示运行中状态。
