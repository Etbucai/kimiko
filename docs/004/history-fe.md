# 引入历史消息记录前端技术方案

## 背景

本文档对应 PRD：[history.md](./history.md)，并基于上一期流式输出前端技术方案：[../003/streaming-fe.md](../003/streaming-fe.md)。

本期目标是把 StoryAgent 页面从“一次性输入故事正文和续写指令”调整为“移动端优先的连续续写工作台”：页面自动恢复用户最近的故事线，正文只读累积展示，底部固定输入续写指令。首轮生成由用户提供初始故事正文和续写指令，后续生成只提交当前故事线标识和新的续写指令。

## 已确认决策

- “故事线”在前端和 IDL 中命名为 `Storyline`。
- 页面继续挂载在 `/`，继续由 `RequireAuth` 保护。
- 页面进入时调用 HTTP 接口恢复当前登录用户最近的故事线。
- 没有历史故事线是正常空态，恢复接口返回 `200` 和 `{ storyline: null }`。
- 恢复接口失败时展示错误页，并提供重试按钮。
- 首轮生成时，前端不预先创建空故事线；服务端在成功完成并保存后返回新 `storylineId`。
- WebSocket 继续使用 `/realtime`，继续使用 `story.continue` 和 `story.cancel`。
- `story.continue` 的 payload 使用 `mode` 区分首轮创建和后续追加。
- 恢复和 completed 事件都返回服务端保存后的分段快照。
- 前端用服务端返回的快照展示正式正文，用本地临时文本展示流式 chunk。
- 取消、生成失败、保存失败时，临时文本从正文中移除。
- 成功完成后，临时文本由服务端快照中的正式生成段替换。
- 正文按 segment 展示，segment 区分 `initial` 和 `generated`。
- 轻量分隔符只由 UI 渲染，不保存、不发送给 LLM。
- 底部续写指令输入框固定在页面底部，按钮提交。
- textarea 中 Enter 保留换行，不触发提交。
- 流式生成时，如果用户接近页面底部则自动跟随最新文本；用户主动上滑时不强制滚动。
- 本期不展示故事线列表，不提供新建、切换、删除、重命名入口。
- 本期不提供正文编辑能力。
- 本期不新增前端第三方依赖。

## 现有前端约束

- 前端使用 React、react-router、Tailwind CSS v4。
- API base URL 来自 `VITE_API_BASE_URL`。
- WebSocket base URL 继续从 `VITE_API_BASE_URL` 推导。
- 登录态保存在 `localStorage`，通过 `getStoredAuthSession()` 读取。
- 本地登录态失效时，页面跳转 `/login`。
- 共享契约使用 `@kimiko/schema` 的 zod schema 和类型。
- TypeScript 文件必须保持严格类型安全，避免 `any`。
- 非原始值 `useState`、`useRef` 必须显式标注泛型。
- 类型导入使用 `import type`。

## IDL Schema

004 的 Storyline 契约放在 `packages/schema/src/index.ts`。前端和服务端共享同一份 zod schema。

### 基础类型

```ts
export const StorylineIdSchema = z.string().trim().min(1);

export type StorylineId = z.infer<typeof StorylineIdSchema>;

export const StorylineSegmentIdSchema = z.string().trim().min(1);

export type StorylineSegmentId = z.infer<
  typeof StorylineSegmentIdSchema
>;
```

### Storyline 分段快照

```ts
export const StorylineInitialSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("initial"),
    text: z.string().trim().min(1),
  })
  .strict();

export type StorylineInitialSegment = z.infer<
  typeof StorylineInitialSegmentSchema
>;

export const StorylineGeneratedSegmentSchema = z
  .object({
    id: StorylineSegmentIdSchema,
    type: z.literal("generated"),
    text: z.string().trim().min(1),
  })
  .strict();

export type StorylineGeneratedSegment = z.infer<
  typeof StorylineGeneratedSegmentSchema
>;

export const StorylineSegmentSchema = z.discriminatedUnion("type", [
  StorylineInitialSegmentSchema,
  StorylineGeneratedSegmentSchema,
]);

export type StorylineSegment = z.infer<typeof StorylineSegmentSchema>;

export const StorylineGenerationMetadataSchema = z
  .object({
    segmentId: StorylineSegmentIdSchema,
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
  })
  .strict();

export type StorylineGenerationMetadata = z.infer<
  typeof StorylineGenerationMetadataSchema
>;

export const StorylineSnapshotSchema = z
  .object({
    id: StorylineIdSchema,
    segments: z.array(StorylineSegmentSchema).min(1),
    latestGeneration: StorylineGenerationMetadataSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type StorylineSnapshot = z.infer<typeof StorylineSnapshotSchema>;

export const CompletedStorylineSnapshotSchema =
  StorylineSnapshotSchema.extend({
    latestGeneration: StorylineGenerationMetadataSchema,
  });

export type CompletedStorylineSnapshot = z.infer<
  typeof CompletedStorylineSnapshotSchema
>;
```

说明：
- `segments` 按展示顺序返回。
- `initial` segment 表示用户首轮提交的初始故事正文。
- `generated` segment 表示 Agent 成功完成并保存的续写正文。
- `latestGeneration` 只用于恢复和展示最新一轮模型、耗时、Token。
- 每轮完整元数据由服务端保存；本期前端只需要最新一轮元数据。
- `updatedAt` 用于调试和后续排序，本期页面不展示。

### 恢复最近 Storyline

```ts
export const GetRecentStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema.nullable(),
  })
  .strict();

export type GetRecentStorylineResponse = z.infer<
  typeof GetRecentStorylineResponseSchema
>;
```

接口契约：
- `GET /storylines/recent`
- 必须登录。
- 请求头包含 `Authorization: Bearer {accessToken}`。
- 有最近故事线时返回 `{ storyline: StorylineSnapshot }`。
- 没有任何故事线时返回 `{ storyline: null }`。
- `401` 表示登录失效，前端清理本地登录态并跳转 `/login`。
- 其他非成功响应、网络错误、响应 schema 不合法，都视为恢复失败。

### Storyline 续写请求

```ts
export const StoryContinueCreatePayloadSchema = z
  .object({
    mode: z.literal("create"),
    initialStoryText: z.string().trim().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueCreatePayload = z.infer<
  typeof StoryContinueCreatePayloadSchema
>;

export const StoryContinueAppendPayloadSchema = z
  .object({
    mode: z.literal("append"),
    storylineId: StorylineIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueAppendPayload = z.infer<
  typeof StoryContinueAppendPayloadSchema
>;

export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueAppendPayloadSchema,
]);

export type StoryContinuePayload = z.infer<
  typeof StoryContinuePayloadSchema
>;
```

说明：
- `mode: "create"` 用于无故事线空态下的首轮生成。
- `mode: "append"` 用于已有故事线的后续生成。
- 004 前端不再把旧的 `ContinueStoryRequest` 作为页面提交契约。
- 前端不提交完整历史，不提交完整累积正文。

### WebSocket 客户端消息

```ts
export const StoryRealtimeRequestIdSchema = z.string().trim().min(1);

export const StoryContinueClientMessageSchema = z
  .object({
    type: z.literal("story.continue"),
    requestId: StoryRealtimeRequestIdSchema,
    payload: StoryContinuePayloadSchema,
  })
  .strict();

export type StoryContinueClientMessage = z.infer<
  typeof StoryContinueClientMessageSchema
>;

export const StoryCancelClientMessageSchema = z
  .object({
    type: z.literal("story.cancel"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryCancelClientMessage = z.infer<
  typeof StoryCancelClientMessageSchema
>;

export const StoryRealtimeClientMessageSchema = z.discriminatedUnion("type", [
  StoryContinueClientMessageSchema,
  StoryCancelClientMessageSchema,
]);

export type StoryRealtimeClientMessage = z.infer<
  typeof StoryRealtimeClientMessageSchema
>;
```

### WebSocket 服务端事件

```ts
export const StoryStartedServerEventSchema = z
  .object({
    type: z.literal("story.started"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryStartedServerEvent = z.infer<
  typeof StoryStartedServerEventSchema
>;

export const StoryChunkServerEventSchema = z
  .object({
    type: z.literal("story.chunk"),
    requestId: StoryRealtimeRequestIdSchema,
    sequence: z.number().int().positive(),
    delta: z.string().min(1),
  })
  .strict();

export type StoryChunkServerEvent = z.infer<
  typeof StoryChunkServerEventSchema
>;

export const StoryCompletedServerEventSchema = z
  .object({
    type: z.literal("story.completed"),
    requestId: StoryRealtimeRequestIdSchema,
    storyline: CompletedStorylineSnapshotSchema,
    generatedSegmentId: StorylineSegmentIdSchema,
  })
  .strict();

export type StoryCompletedServerEvent = z.infer<
  typeof StoryCompletedServerEventSchema
>;

export const StoryCancelledServerEventSchema = z
  .object({
    type: z.literal("story.cancelled"),
    requestId: StoryRealtimeRequestIdSchema,
  })
  .strict();

export type StoryCancelledServerEvent = z.infer<
  typeof StoryCancelledServerEventSchema
>;

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
]);

export type StoryRealtimeErrorCode = z.infer<
  typeof StoryRealtimeErrorCodeSchema
>;

export const StoryErrorServerEventSchema = z
  .object({
    type: z.literal("story.error"),
    requestId: z.string(),
    code: StoryRealtimeErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type StoryErrorServerEvent = z.infer<
  typeof StoryErrorServerEventSchema
>;

export const StoryRealtimeServerEventSchema = z.discriminatedUnion("type", [
  StoryStartedServerEventSchema,
  StoryChunkServerEventSchema,
  StoryCompletedServerEventSchema,
  StoryCancelledServerEventSchema,
  StoryErrorServerEventSchema,
]);

export type StoryRealtimeServerEvent = z.infer<
  typeof StoryRealtimeServerEventSchema
>;
```

说明：
- `story.chunk` 只用于临时流式展示。
- `story.completed` 表示 LLM 生成完成且服务端保存成功。
- `story.completed.storyline` 是前端新的正式快照来源。
- `generatedSegmentId` 指向本轮新增的 `generated` segment。
- `STORYLINE_NOT_FOUND` 表示故事线不存在、已删除或不属于当前用户。
- `STORYLINE_BUSY` 表示同一故事线已有活跃生成任务。
- `STORYLINE_SAVE_FAILED` 表示 LLM 已完成但服务端保存失败。
- 前端展示稳定通用文案，不透出服务端技术细节。

## 文件组织

新增或调整以下文件：

- `packages/schema/src/index.ts`
  - 增加 Storyline IDL schema。
  - 更新 `story.continue` payload 为 `StoryContinuePayloadSchema`。
  - 扩展 WebSocket 错误码。
- `packages/web/src/story/storylineApi.ts`
  - 封装 `GET /storylines/recent`。
  - 负责读取登录态、发送 Bearer token、解析 `GetRecentStorylineResponseSchema`。
- `packages/web/src/story/storyRealtimeApi.ts`
  - 保留 WebSocket URL 推导、鉴权、消息解析、取消和关闭逻辑。
  - 将启动参数从旧 `ContinueStoryRequest` 改为 `StoryContinuePayload`。
  - `onCompleted` 回调接收包含 `storyline` 快照的 completed 事件。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 增加恢复最近故事线的加载态、空态、错误页和重试逻辑。
  - 管理正式 `StorylineSnapshot`、临时流式文本、底部指令、首轮初始正文。
  - 负责首轮 create payload 和后续 append payload 的选择。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - 渲染只读故事正文分段和临时流式文本。
  - 负责 UI 分隔符展示。
- `packages/web/src/pages/story/StorylineComposer.tsx`
  - 渲染底部固定续写指令输入框、生成按钮、取消按钮。
- `packages/web/src/pages/story/StoryInitialInput.tsx`
  - 仅在无故事线空态展示初始故事正文输入区域。
- `packages/web/src/pages/story/StorylineRestoreError.tsx`
  - 展示恢复失败错误页和重试按钮。

可以删除或重构以下旧组件：

- `StoryForm.tsx`
  - 旧的双 textarea 表单不再匹配 004 页面结构。
- `StoryResult.tsx`
  - 旧的独立结果卡片不再匹配正文累积展示方式。

## HTTP API 设计

`storylineApi.ts` 暴露：

```ts
export type GetRecentStorylineResult =
  | Readonly<{ status: "success"; storyline: StorylineSnapshot | null }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getRecentStoryline(): Promise<GetRecentStorylineResult>;
```

处理规则：
- 调用时读取 `getStoredAuthSession()`。
- session 不存在或已失效时，返回 `authRequired`。
- 请求 `GET /storylines/recent`。
- 请求头携带 `Authorization: Bearer ${accessToken}`。
- 成功响应使用 `GetRecentStorylineResponseSchema.safeParse` 校验。
- 响应 `401` 时清理本地登录态并返回 `authRequired`。
- 网络失败、非 `2xx`、响应 schema 不合法时返回 `failed`。
- `failed.message` 使用通用文案，默认 `恢复故事线失败，请稍后重试`。

## Realtime API 设计

`storyRealtimeApi.ts` 暴露：

```ts
export interface StoryRealtimeGenerationCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onCompleted: (event: StoryCompletedServerEvent) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

export interface StoryRealtimeGenerationHandle {
  cancel: () => void;
  close: () => void;
}

export function startStoryRealtimeGeneration(
  payload: StoryContinuePayload,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle;
```

处理规则：
- 调用时读取 `getStoredAuthSession()`。
- session 不存在或失效时，不建连，直接触发 `onAuthRequired`。
- 建连 URL 继续从 `VITE_API_BASE_URL` 推导：

```ts
function getRealtimeBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/realtime";
  url.search = "";
  url.hash = "";
  return url.toString();
}
```

- 建连时追加 `accessToken` 查询参数。
- `requestId` 使用 `crypto.randomUUID()` 生成。
- socket open 后发送：

```ts
{
  type: "story.continue",
  requestId,
  payload,
} satisfies StoryContinueClientMessage;
```

- 收到不同 `requestId` 的服务端事件时忽略。
- 收到 `story.started` 后触发 `onStarted`。
- 收到 `story.chunk` 后触发 `onChunk(delta, sequence)`。
- 收到 `story.completed` 后触发 `onCompleted(event)` 并关闭连接。
- 收到 `story.cancelled` 后触发 `onCancelled()` 并关闭连接。
- 收到 `story.error` 后触发 `onError(event.message)` 并关闭连接。
- 收到无法解析或不符合 schema 的消息时触发 `onError("生成失败，请稍后重试")` 并关闭连接。
- WebSocket close code `1008` 表示鉴权失效，清理本地登录态并触发 `onAuthRequired`。
- `close()` 用于组件卸载清理，不触发 UI 状态回调。

取消规则：
- 生成中主按钮文案为 `取消生成`。
- 点击取消时调用 `cancel()`。
- socket open 后发送 `story.cancel`。
- 如果 socket 还未 open，则直接关闭 socket 并触发取消状态。
- 取消后页面移除临时文本，保留正式快照和续写指令。

## 页面状态模型

`StoryPage` 使用组件本地状态，不引入全局 Store，不写入 localStorage。

```ts
type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";

interface StorylinePageState {
  status: StorylinePageStatus;
  storyline: StorylineSnapshot | null;
  initialStoryText: string;
  instruction: string;
  temporaryGeneratedText: string;
  restoreErrorMessage: string;
  generationStatusMessage: string;
}
```

状态规则：
- 初始进入 `loading`。
- 恢复成功且 `storyline === null` 时进入 `empty`。
- 恢复成功且 `storyline !== null` 时进入 `ready`。
- 恢复失败时进入 `restoreFailed`。
- 点击错误页重试按钮后重新进入 `loading`。
- 点击生成前先校验字段。
- `empty` 状态生成时校验 `initialStoryText` 和 `instruction`。
- `ready`、`completed`、`cancelled`、`failed` 状态生成时只校验 `instruction`。
- 校验通过后清空 `temporaryGeneratedText` 和旧生成提示，进入 `connecting`。
- 收到 `story.started` 后进入 `streaming`。
- 收到 `story.chunk` 后追加 `temporaryGeneratedText`。
- 收到 `story.completed` 后：
  - 用 `event.storyline` 替换正式 `storyline`。
  - 清空 `temporaryGeneratedText`。
  - 清空 `instruction`。
  - 清空 `initialStoryText`。
  - 进入 `completed`。
- 收到 `story.cancelled` 后：
  - 清空 `temporaryGeneratedText`。
  - 保留 `instruction`。
  - 保留 `initialStoryText`。
  - 正式 `storyline` 不变。
  - 进入 `cancelled`。
- 收到错误或连接异常后：
  - 清空 `temporaryGeneratedText`。
  - 保留 `instruction`。
  - 保留 `initialStoryText`。
  - 正式 `storyline` 不变。
  - 进入 `failed`。
- 组件卸载时关闭当前 WebSocket 连接。

## Payload 构造

首轮空态：

```ts
const payload = {
  mode: "create",
  initialStoryText: initialStoryText.trim(),
  instruction: instruction.trim(),
} satisfies StoryContinueCreatePayload;
```

已有故事线：

```ts
const payload = {
  mode: "append",
  storylineId: storyline.id,
  instruction: instruction.trim(),
} satisfies StoryContinueAppendPayload;
```

说明：
- 前端不拼接历史消息。
- 前端不把 `segments` 重新拼成正文传回服务端。
- 前端不把 UI 分隔符传给服务端。
- 前端只根据当前状态选择 `create` 或 `append`。

## UI 行为

### 页面布局

- 页面使用移动端优先布局。
- 主体区域展示故事正文和状态提示。
- 底部 composer 使用 `position: fixed` 或等价布局固定在视口底部。
- 主体区域需要预留底部 padding，避免正文被 composer 遮挡。
- 底部 composer 需要处理 `safe-area-inset-bottom`。
- 桌面端可以保持居中窄栏，避免行宽过长。

### 加载态

- 页面恢复最近故事线期间展示全页轻量加载态。
- 加载态不展示空白输入区，避免有历史时出现闪烁。
- 加载态不允许提交生成。

### 恢复失败页

- 恢复失败时展示错误页。
- 错误页展示通用文案：`恢复故事线失败，请稍后重试`。
- 错误页提供 `重试` 按钮。
- 点击重试重新调用 `getRecentStoryline()`。
- 鉴权失效不展示错误页，直接进入登录流程。

### 空态

- 无故事线时展示初始故事正文输入区域。
- 初始故事正文输入区域位于主体区域。
- 底部 composer 始终展示续写指令输入框和主按钮。
- 首轮生成时初始故事正文和续写指令都必填。

### 正文展示

- `StorylineReader` 只展示 `storyline.segments` 和 `temporaryGeneratedText`。
- `initial` segment 直接展示为正文。
- `generated` segment 展示为正文续写段。
- 多个 `generated` segment 之间展示轻量弱分隔符。
- 分隔符使用弱化样式，例如细线或小号状态文本。
- 分隔符不参与复制逻辑，本期不提供复制按钮。
- 指令历史不展示在正文区。

### 流式临时文本

- 收到 `story.chunk` 时追加到 `temporaryGeneratedText`。
- 临时文本展示在正文尾部。
- 临时文本可使用弱化状态标记表示“生成中”。
- completed 前不把临时文本写入正式 `segments`。
- completed 后用 `event.storyline` 替换正式快照，并清空临时文本。
- cancelled、failed 时清空临时文本，正式正文不变。

### 底部输入区

- 底部 composer 包含续写指令 textarea 和主按钮。
- textarea 支持多行输入。
- Enter 保持换行。
- 只通过按钮提交。
- 默认按钮文案为 `生成续写`。
- `connecting` / `streaming` 时按钮文案为 `取消生成`。
- `connecting` / `streaming` 时 textarea 暂时不可编辑。
- 取消、失败、保存失败后保留 textarea 内容。
- 成功完成后清空 textarea。

### 最新元数据

- `storyline.latestGeneration` 非空时展示最新一轮模型、耗时、Token。
- 元数据使用弱化样式展示在正文尾部或 composer 上方。
- 只展示最新一轮，不展示每段历史元数据。
- 元数据不属于正文内容。

### 滚动策略

- 页面维护正文滚动容器或窗口滚动位置。
- 每次收到 chunk 前判断用户是否接近底部。
- 接近底部时，chunk 渲染后自动滚动到最新内容。
- 用户主动上滑查看旧内容时，不强制滚回底部。
- completed 后，如果用户接近底部，滚动到正式生成段尾部。
- 阈值建议为 120px 到 160px。

## 字段校验

### 初始故事正文

- 仅 `mode: "create"` 时校验。
- trim 后非空。
- 最大长度 20000 字符。
- 为空时展示字段级错误：`请输入故事正文`。

### 续写指令

- 每轮都校验。
- trim 后非空。
- 最大长度 8000 字符。
- 为空时在底部输入区附近展示字段级错误：`请输入续写指令`。

## 错误处理

- `getRecentStoryline()` 返回 `authRequired` 时跳转 `/login`。
- `getRecentStoryline()` 返回 `failed` 时展示恢复失败页。
- `story.error` 使用服务端返回的 `message` 展示。
- 无法解析的 WebSocket 消息展示 `生成失败，请稍后重试`。
- WebSocket 异常关闭展示 `生成失败，请稍后重试`。
- `STORYLINE_BUSY` 可展示 `当前故事线正在生成，请稍后重试`。
- `STORYLINE_SAVE_FAILED` 可展示 `保存失败，请稍后重试`。
- 生成失败、保存失败、取消都不改变正式 `storyline` 快照。
- 生成失败、保存失败、取消都保留当前续写指令。
- 生成失败、保存失败、取消都移除临时文本。

## 鉴权行为

- `/` 仍由 `RequireAuth` 包裹。
- 恢复最近故事线前再次读取本地 session。
- 发起 WebSocket 前再次读取本地 session。
- HTTP `401` 清理本地登录态并跳转 `/login`。
- WebSocket close code `1008` 清理本地登录态并跳转 `/login`。
- 前端不把用户信息放入 Storyline payload。

## 样式方案

- 使用 Tailwind utility classes，不新增 CSS 依赖。
- 页面背景和卡片颜色复用现有 CSS 变量：
  - `--bg`
  - `--panel-bg`
  - `--border`
  - `--text`
  - `--text-h`
  - `--accent`
  - `--danger`
- 正文使用 `whitespace-pre-wrap` 保留换行。
- 正文字号和行高优先照顾移动端阅读。
- 底部 composer 使用高对比按钮，保证移动端可点击面积。
- 错误提示使用现有 danger 色系。

## 验收标准

- 登录用户访问 `/` 时先看到恢复加载态。
- 无历史故事线时，页面进入空态并展示初始故事正文输入区域。
- 有历史故事线时，页面展示服务端返回的分段正文快照。
- 恢复失败时，页面展示错误页和重试按钮。
- 鉴权失效时，页面进入登录流程。
- 底部续写指令输入框固定在页面底部。
- 首轮空态生成时，初始故事正文为空会展示字段级错误。
- 每轮生成时，续写指令为空会展示字段级错误。
- 首轮生成发送 `mode: "create"` payload。
- 后续生成发送 `mode: "append"` payload。
- 后续生成 payload 只包含 `storylineId` 和 `instruction`，不包含完整历史正文。
- 收到 chunk 时，临时文本在正文尾部流式展示。
- 接近底部时，流式文本自动跟随滚动。
- 用户上滑查看旧文时，流式文本不强制拉回底部。
- completed 后，前端用 `event.storyline` 替换正式快照。
- completed 后，续写指令输入框自动清空。
- completed 后，页面展示最新一轮模型、耗时、Token。
- cancelled 后，临时文本移除，正式正文保持不变。
- failed 后，临时文本移除，正式正文保持不变。
- 保存失败后，临时文本不进入正式正文。
- 取消、失败、保存失败后，续写指令保留。
- 用户指令不展示在正文区。
- UI 分隔符不进入 payload。
- UI 分隔符不作为 segment text 展示来源。
- 同一故事线 busy 错误能展示可理解提示。

## 验证命令

实现完成后执行：

```bash
pnpm --filter @kimiko/schema typecheck
pnpm --filter @kimiko/schema lint
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```
