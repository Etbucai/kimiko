# LLM 后台生成与手动取消服务端技术方案

## 背景

本文档对应总方案：[llm-background-generation.md](./llm-background-generation.md) 和前端方案：[llm-background-generation-fe.md](./llm-background-generation-fe.md)。

当前服务端的故事生成任务由 `RealtimeGateway.continueStory` 直接执行。任务的 `AbortController` 保存在单个 WebSocket client state 中，`cleanupClient` 会在连接关闭时调用 `abort()`。因此前端掉线、刷新、退出页面或跳转调试页都会停止 LLM 生成。

本期服务端目标是把“生成任务生命周期”从“WebSocket 连接生命周期”中拆出来：WebSocket 断开只解绑当前 observer，任务继续在服务端运行；只有用户明确取消时，服务端才尝试 abort。

## 已确认决策

- 新增独立服务端技术文档：`docs/010/llm-background-generation-server.md`。
- 后台任务状态保存在服务端内存中，不落库。
- 服务端重启后任务状态丢失可接受。
- 后台生成任务执行循环由 `StoryGenerationTaskService` 拥有。
- `StoryGenerationTaskService` 内部使用 `StoryGenerationTaskRegistry` 管理内存状态。
- `StoryGenerationTaskService` / `StoryGenerationTaskRegistry` 放在 `packages/server/src/storyline/`。
- `StorylineModule` 注册并导出任务服务，供 `RealtimeGateway` 和 `StorylineController` 使用。
- `RealtimeGateway` 只负责鉴权、解析 WebSocket 消息、创建任务、绑定 observer 和转发实时事件。
- `StorylineGenerationService` 不管理任务状态，只通过内部 `onPhaseChange` callback 上报阶段。
- 不扩展对外 WebSocket stream event 来承载 phase。
- 同一任务最多允许一个 WebSocket observer。
- 新连接遇到同一故事线已有任务时返回 `STORYLINE_BUSY`，不自动 attach。
- WebSocket `story.cancel` 仍要求 `requestId` 完全匹配。
- REST 后台取消按 `storylineId` 定位，不依赖 requestId。
- REST 状态 / 取消接口先调用 `StorylineService` 校验故事线归属，不只查 registry。
- 无活跃任务时 REST cancel 幂等成功。
- 用户取消后立即标记 `cancelled`，立即对外返回和发送 `story.cancelled`。
- 任务进入 `saving` 后不打断数据库保存；若保存成功，最终 `completed` 优先。
- 同一 `userId + storylineId` 只保留一个状态槽；新任务启动覆盖旧终态。
- 终态 TTL 为 10 分钟，使用 `setTimeout` 清理，并在查询时做 lazy 过期判断。
- 错误码和错误文案复用现有 WebSocket 映射，抽成共享 util，避免 REST 与 WebSocket 不一致。
- create 断线后继续跑，但不通过 REST 暴露运行中状态或终态；只记录日志并自然清理。
- 测试优先补 `TaskService/Registry` 单测和 realtime e2e。

## 非目标

- 不引入持久化任务队列。
- 不支持服务端重启后恢复 LLM 请求。
- 不缓存或补发断线期间的 `story.chunk`。
- 不支持多个 observer 同步流式正文。
- 不为 create 提供找回或退出后取消能力。
- 不新增 user-level active create 查询接口。
- 不做已保存 segment/context 的回滚。
- 不新增 `cancelling` 状态。
- 不改变正文保存和 context 保存的事务原子性。

## 现有服务端约束

- 服务端使用 NestJS。
- 共享契约集中在 `@kimiko/schema`，使用 Zod 作为 SSOT。
- `RealtimeGateway` 当前直接执行 `for await` 生成循环。
- `RealtimeClientState.activeTask` 当前保存 `AbortController` 和 `requestId`。
- `RealtimeGateway.cleanupClient` 当前会 abort active task。
- `StorylineGenerationService.streamContinueStoryline` 当前只 yield：
  - `chunk`
  - `contextStarted`
  - `completed`
- `StorylineGenerationService` 已有内部 `logGenerationPhase`，但没有对外 phase callback。
- `StorylineLockService` 已提供用户级 create 锁和故事线级锁。
- `StorylineController` 目前已有 list/recent/detail/context REST 接口。
- `realtime.e2e-spec.ts` 已覆盖 WebSocket 流式生成、busy 和 cancel。

## 设计总览

新增两个服务端内部组件：

```text
StoryGenerationTaskService
  - start(input, observer)
  - cancelByRequest(input)
  - cancelByStoryline(input)
  - getStorylineTaskStatus(input)
  - owns async run loop

StoryGenerationTaskRegistry
  - store active tasks
  - store terminal tasks for 10 minutes
  - attach/detach the single observer
  - update phase / terminal state
  - run TTL cleanup
```

调用关系：

```text
RealtimeGateway
  story.continue
    -> StoryGenerationTaskService.start(...)
    -> observer sends story.started/chunk/context.started/completed/error

RealtimeGateway
  story.cancel
    -> StoryGenerationTaskService.cancelByRequest(...)

StorylineController
  GET :storylineId/generation/status
    -> StorylineService.getStorylineForUser(...)
    -> StoryGenerationTaskService.getStorylineTaskStatus(...)

StorylineController
  POST :storylineId/generation/cancel
    -> StorylineService.getStorylineForUser(...)
    -> StoryGenerationTaskService.cancelByStoryline(...)
```

`StorylineGenerationService` 仍负责具体 create / append / rewrite / dialogue 编排；任务服务只负责后台任务生命周期和 observer 转发。

## 共享契约

在 `packages/schema/src/index.ts` 新增：

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

export const StoryGenerationTaskSchema = z
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
  .strict();

export const StoryGenerationStatusResponseSchema = z
  .object({
    task: StoryGenerationTaskSchema.nullable(),
  })
  .strict();

export const CancelStoryGenerationResponseSchema = z
  .object({
    cancelled: z.boolean(),
    task: StoryGenerationTaskSchema.nullable(),
  })
  .strict();
```

规则：

- `running` 必须带 `phase`。
- `completed` 应带 `generatedSegmentId`，但 create 不通过 REST 暴露。
- `failed` 应带 `errorCode` 和 `message`。
- `cancelled` 可不带 `phase`。
- `task: null` 表示当前故事线没有活跃任务或可见终态。

## 内部类型

建议新增 `packages/server/src/storyline/story-generation-task.types.ts`。

```ts
export type StoryGenerationPhase =
  "preparing" | "streaming" | "updatingContext" | "saving";

export type StoryGenerationTaskTerminalStatus =
  "completed" | "failed" | "cancelled";

export interface StoryGenerationObserver {
  readonly requestId: string;
  sendStarted(): void;
  sendChunk(event: Extract<StorylineStreamEvent, { type: "chunk" }>): void;
  sendContextStarted(): void;
  sendCompleted(
    event: Extract<StorylineStreamEvent, { type: "completed" }>,
  ): void;
  sendCancelled(): void;
  sendError(input: {
    readonly code: RealtimeErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  }): void;
}
```

observer 由启动任务的 WebSocket 连接创建。`requestId` 是 observer 和 task 的绑定键；Gateway client state 也保存同一个 `requestId`，用于 cancel 和 detach 时定位。

Task record 内部建议包含：

```ts
interface StoryGenerationTaskRecord {
  readonly key: StoryGenerationTaskKey;
  readonly abortController: AbortController;
  readonly mode: StoryGenerationMode;
  readonly requestId: string;
  readonly userId: string;
  readonly storylineId: string | null;
  readonly startedAt: number;
  readonly observer: StoryGenerationObserver | null;
  phase: StoryGenerationPhase;
  status: "running" | "completed" | "failed" | "cancelled";
  generatedSegmentId?: string;
  errorCode?: RealtimeErrorCode;
  message?: string;
  terminalAt?: number;
  expiresAt?: number;
  cleanupTimer?: NodeJS.Timeout;
}
```

实现时不要用 `any`。所有跨函数传递的结构体都要有明确类型。

## Task Key

已有故事线任务：

```text
storyline:${userId}:${storylineId}
```

create 任务：

```text
create:${userId}:${requestId}
```

说明：

- 已有故事线任务可通过 REST status/cancel 查询。
- create 任务只为继续执行、取消原连接和日志服务，不通过 REST 暴露。
- 同一故事线状态槽只有一个；新任务启动时覆盖旧终态。

## TaskService 接口

### `start`

```ts
start(input: {
  readonly userId: string;
  readonly payload: StoryContinuePayload;
  readonly requestId: string;
  readonly observer: StoryGenerationObserver;
}): StartStoryGenerationTaskResult;
```

返回：

```ts
type StartStoryGenerationTaskResult =
  | Readonly<{ status: "started" }>
  | Readonly<{ status: "busy"; code: "BUSY" | "STORYLINE_BUSY" }>;
```

行为：

- 如果同一个 WebSocket observer 已经有 task，Gateway 仍可先用 client state 返回 `BUSY`。
- 如果同一 `userId + storylineId` 已有 active task，返回 `STORYLINE_BUSY`。
- 如果同一 key 有 terminal task，启动新任务前覆盖旧终态并清理旧 timer。
- 创建 `AbortController`。
- 在 registry 中注册 running task，初始 phase 为 `preparing`。
- 立即通过 observer 发送 `story.started`。
- 异步启动 run loop，不阻塞 WebSocket message handler。

### `cancelByRequest`

用于 WebSocket `story.cancel`。

```ts
cancelByRequest(input: {
  readonly userId: string;
  readonly requestId: string;
  readonly activeRequestId: string | null;
}): CancelStoryGenerationTaskResult;
```

规则：

- 只取消当前 WebSocket client state 绑定的任务。
- 必须 requestId 匹配。
- 不匹配时返回 no active task，由 Gateway 发送 `NO_ACTIVE_TASK`。
- 匹配时立即标记 cancelled，调用 abort，发送 `story.cancelled`。

### `cancelByStoryline`

用于 REST `POST /storylines/:storylineId/generation/cancel`。

```ts
cancelByStoryline(input: {
  readonly userId: string;
  readonly storylineId: string;
}): CancelStoryGenerationResponse;
```

规则：

- 只查 `storyline:${userId}:${storylineId}`。
- 无 active task 时返回 `cancelled: false` 和当前可见终态或 `task: null`。
- active task 仍在 `preparing` / `streaming` / `updatingContext` 时：
  - 立即标记 `cancelled`。
  - 调用 `abortController.abort()`。
  - 如果 observer 仍存在，发送 `story.cancelled`。
  - 返回 `cancelled: true` 和 cancelled task。
- active task 已进入 `saving` 时：
  - 不打断保存。
  - 如果保存最终成功，返回或后续查询显示 `completed`。
  - 如果保存失败，返回或后续查询显示 `failed`。

实现上可通过任务 record 的 `phase === "saving"` 判定保存优先。

### `getStorylineTaskStatus`

```ts
getStorylineTaskStatus(input: {
  readonly userId: string;
  readonly storylineId: string;
}): StoryGenerationStatusResponse;
```

规则：

- 返回 active task。
- 或返回 10 分钟内未过期 terminal task。
- 过期时 lazy cleanup 并返回 `task: null`。
- create task 不通过该接口返回。

## Registry 状态机

```text
running(preparing)
  -> running(streaming)
  -> running(updatingContext)
  -> running(saving)
  -> completed

running(preparing|streaming|updatingContext)
  -> cancelled

running(*)
  -> failed
```

特殊规则：

- `saving -> completed` 优先于取消。
- cancelled 后 run loop 后续抛出的 abort 相关错误不覆盖 terminal status。
- completed / failed / cancelled 都设置 `terminalAt` 和 `expiresAt`。
- terminal task 设置 10 分钟 cleanup timer。
- 新任务启动覆盖同一 key 的 terminal task。

## Phase Callback

`StorylineGenerationService.streamContinueStoryline` 的 options 扩展：

```ts
export interface StorylineGenerationOptions {
  readonly signal: AbortSignal;
  readonly onPhaseChange?: (phase: StorylineGenerationPhaseEvent) => void;
}

export interface StorylineGenerationPhaseEvent {
  readonly phase: StoryGenerationPhase;
}
```

映射规则：

| 内部位置                                      | 对外 phase        |
| --------------------------------------------- | ----------------- |
| request received / lookup / lock / build ctx  | `preparing`       |
| writer stream started / first chunk / chunks  | `streaming`       |
| contextStarted event / context patch generate | `updatingContext` |
| 调用 `save*WithContext` 前                    | `saving`          |

实现建议：

- 在 `StorylineGenerationService` 内部新增 `emitPhase(options, phase)`。
- phase 重复时可由 TaskService 去重，避免日志噪声。
- 不把 phase event yield 给 WebSocket。
- `contextStarted` 仍继续 yield，用于原页面实时 UI。
- `noop_save_completed` 的 dialogue 无事发生分支可从 `streaming` 直接进入 `saving` 或直接 completed；建议在保存无事发生 segment 前 emit `saving`。

## RealtimeGateway 调整

### Client State

`RealtimeClientState.activeTask` 不再保存 `AbortController`。

建议改为：

```ts
export interface ActiveRealtimeTask {
  readonly requestId: string;
}
```

或者只在 TaskService 内部维护 observer 绑定，Gateway client state 保存 `activeRequestId`。

### `continueStory`

调整方向：

- 不再创建 `AbortController`。
- 不再直接 `for await` 消费 `StorylineGenerationService`。
- 构造 `StoryGenerationObserver`：
  - observer 内部调用现有 `sendEvent`。
  - observer 发送前检查 WebSocket open。
- 调用 `taskService.start(...)`。
- `started` 成功后设置 client active task。
- 如果返回 busy：
  - client 已有任务：发送 `BUSY`。
  - 故事线已有任务：发送 `STORYLINE_BUSY`。

### `cancelStory`

调整方向：

- 仍校验当前 client state 是否有 active task。
- 仍校验 requestId 匹配。
- 调用 `taskService.cancelByRequest(...)`。
- 成功后清理 client active task。
- 失败时发送 `NO_ACTIVE_TASK`。

### `cleanupClient`

调整方向：

- 不再调用 `abortController.abort()`。
- 按 client state 中的 active `requestId` 调用 task service detach 当前 observer。
- 删除 client state。
- 记录 `story_generation_task_observer_detached` 或等价日志。

## StorylineController 调整

新增接口：

```ts
@Get(":storylineId/generation/status")
@UseGuards(JwtAuthGuard)
async getGenerationStatus(...)

@Post(":storylineId/generation/cancel")
@UseGuards(JwtAuthGuard)
async cancelGeneration(...)
```

注意：

- 需要从 `@nestjs/common` 引入 `Post`。
- 两个接口都先调用 `storylineService.getStorylineForUser(user.userId, storylineId)`。
- 返回 null 时抛 `NotFoundException("Storyline not found")`。
- status 接口返回 task service 查询结果。
- cancel 接口返回 task service cancel 结果。

## 错误映射

当前 `mapStreamErrorCode` 和 `errorMessages` 在 `RealtimeGateway` 内部。需要抽出共享文件，例如：

```text
packages/server/src/realtime/realtime-error.utils.ts
```

导出：

```ts
export const realtimeErrorMessages: Record<RealtimeErrorCode, string>;
export function mapRealtimeStreamErrorCode(error: unknown): RealtimeErrorCode;
export function getRealtimeErrorMessage(code: RealtimeErrorCode): string;
```

使用方：

- `RealtimeGateway` 发送 `story.error`。
- `StoryGenerationTaskService` 记录 failed terminal task。
- REST status 返回 failed task message。

这样 `STORY_CONTEXT_FAILED`、`STORYLINE_SAVE_FAILED`、`STORY_SEGMENT_NOT_REWRITABLE` 等错误码在 WebSocket 和 REST 中一致。

## Observer 语义

每个任务最多一个 observer。

observer 存在时：

- `story.started`
- `story.chunk`
- `story.context.started`
- `story.completed`
- `story.cancelled`
- `story.error`

observer 断开后：

- 后续事件不发送。
- chunk 不缓存。
- task 继续运行。
- 用户重新进入页面只能通过 REST status 查询阶段和终态。

如果 observer 断开后任务失败：

- 记录 failed terminal task。
- REST status 在 10 分钟内可查询。

如果 observer 断开后任务完成：

- 正常落库。
- REST status 在 10 分钟内可查询 completed。

## Create 模式

create 没有 `storylineId`，因此：

- 可通过 WebSocket 原连接取消，仍按 requestId。
- 原连接断开后继续生成。
- 不支持 REST status。
- 不支持 REST cancel。
- 完成后只通过 recent/list 体现新故事线。
- TaskService 仍需要清理 create task，避免内存泄漏。

建议 create terminal 不进入 REST 可见 terminal map；run loop finally 中直接删除 active create task，记录日志即可。

## 日志要求

新增结构化日志：

```text
story_generation_task_started
story_generation_task_phase_changed
story_generation_task_observer_detached
story_generation_task_cancel_requested
story_generation_task_terminal
story_generation_task_ttl_cleanup
```

字段建议：

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
- `reason`

日志注意：

- 不记录 prompt、正文全文、context JSON 等大文本。
- 异常链路必须记录 `toLoggableError(error)`。
- cancelled 由用户触发时记录 `reason: "user_cancelled"`。
- observer 断开时记录 closeCode / closeReason。

## 文件调整

### 共享契约

- `packages/schema/src/index.ts`
  - 新增 `StoryGenerationPhaseSchema`。
  - 新增 `StoryGenerationTaskStatusSchema`。
  - 新增 `StoryGenerationModeSchema`。
  - 新增 `StoryGenerationTaskSchema`。
  - 新增 `StoryGenerationStatusResponseSchema`。
  - 新增 `CancelStoryGenerationResponseSchema`。

### 服务端

- `packages/server/src/storyline/story-generation-task.types.ts`
  - 新增内部任务类型。
- `packages/server/src/storyline/story-generation-task.registry.ts`
  - 新增内存状态注册表。
- `packages/server/src/storyline/story-generation-task.service.ts`
  - 新增任务启动、取消、查询和 run loop。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - options 增加 `onPhaseChange`。
  - 在关键阶段 emit phase。
- `packages/server/src/storyline/storyline.types.ts`
  - 新增 generation options / phase event 类型。
- `packages/server/src/storyline/storyline.controller.ts`
  - 新增 status / cancel REST endpoint。
- `packages/server/src/storyline/storyline.module.ts`
  - 注册并导出 `StoryGenerationTaskService`。
- `packages/server/src/realtime/realtime.gateway.ts`
  - 移除直接执行生成循环。
  - 改为调用 task service。
  - cleanup 不再 abort。
- `packages/server/src/realtime/realtime.types.ts`
  - 调整 active task 类型。
- `packages/server/src/realtime/realtime-error.utils.ts`
  - 抽出错误码映射和错误文案。

## 测试计划

### 单元测试

新增：

```text
packages/server/src/storyline/story-generation-task.registry.spec.ts
packages/server/src/storyline/story-generation-task.service.spec.ts
```

覆盖：

- 注册 active task。
- 同一故事线 active task 拒绝第二个任务。
- 新任务覆盖旧 terminal task。
- phase update 去重和状态更新。
- cancel 在 preparing / streaming / updatingContext 立即进入 cancelled。
- cancel 在 saving 不覆盖 completed。
- failed task 保存 errorCode/message。
- terminal TTL timeout 清理。
- 查询时 lazy cleanup 过期 terminal。
- create task 不通过 storyline status 返回。

### E2E 测试

更新 `packages/server/test/realtime.e2e-spec.ts`：

- WebSocket 断开后，生成继续执行并最终落库。
- WebSocket 断开后，已有故事线 status 返回 running。
- phase 进入 context 或 saving 时，status 能反映对应阶段。
- completed 后，status 10 分钟内返回 completed + generatedSegmentId。
- REST cancel 能取消后台已有故事线任务。
- 无 active task 时 REST cancel 返回 `cancelled: false`。
- 原 WebSocket 连接未断开时，实时 chunk / context / completed 不退化。
- 同一故事线后台 running 时，新的 `story.continue` 返回 `STORYLINE_BUSY`。
- create 断线后继续完成，但不通过 storyline status 找回。

### 验证命令

- `pnpm --filter @kimiko/server typecheck`
- `pnpm --filter @kimiko/server lint`
- `pnpm --filter @kimiko/server test`
- `pnpm --filter @kimiko/server test:e2e`

## 风险与处理

### Gateway 职责迁移

`RealtimeGateway` 当前承担完整 for-await 生成循环。迁移到 TaskService 时要避免行为退化：

- 保持原有 WebSocket event 顺序。
- 保持原有 requestId。
- 保持原有错误码。
- 保持原有实时 cancel 行为。

### 取消与保存竞态

取消是 best-effort。`saving` 一旦开始，不再打断保存。实现时需要确保：

- `saving` phase 设置发生在调用 `save*WithContext` 之前。
- cancel 看到 `saving` 后不直接写 cancelled。
- save 成功后写 completed。

### 终态覆盖

同一故事线只保留一个状态槽。新任务启动时覆盖旧终态，符合前端只关心当前任务的模型。

### create 任务泄漏

create 不通过 REST 暴露，但仍必须在 completed/failed/cancelled 后从 active map 删除，并记录 terminal 日志。

## 验收标准

- WebSocket close 不再导致 LLM abort。
- 用户显式 WebSocket cancel 仍能取消原页面实时任务。
- REST cancel 能按 storylineId 取消后台任务。
- 同一故事线已有任务运行时，新的生成请求返回 `STORYLINE_BUSY`。
- REST status 能返回 running phase 和 10 分钟内终态。
- create 断线后继续跑，但 REST status 不暴露 create。
- 原有实时流式事件顺序不退化。
- 服务端 typecheck、lint、unit test、e2e test 通过。
