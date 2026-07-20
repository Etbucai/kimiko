# 流式输出前端技术方案

## 背景
本文档对应 PRD：[streaming.md](./streaming.md)，参考服务端技术方案：[streaming-server.md](./streaming-server.md)，并基于上一期 StoryAgent 前端：[../002/story-fe.md](../002/story-fe.md)。

本期目标是把 StoryAgent 页面从非流式 HTTP 生成改为 WebSocket 流式生成：用户点击生成后，页面即时追加展示服务端返回的文本增量，并在完成后展示模型、耗时和 Token。

## 已确认决策
- Story 页面继续挂载在 `/`，继续由 `RequireAuth` 保护。
- 本期生成链路替换为 WebSocket 流式输出。
- 删除现有非流式 HTTP `continueStory` 客户端，不保留页面 fallback。
- WebSocket base URL 从 `VITE_API_BASE_URL` 推导，不新增环境变量。
- 点击生成时临时建立 WebSocket 连接。
- 生成完成、取消、失败或组件卸载时关闭 WebSocket 连接。
- 生成中主按钮文案改为 `取消生成`，点击后发送 `story.cancel`。
- 收到 `story.chunk` 时即时追加正文。
- 模型、耗时、Token 在 `story.completed` 后展示。
- 用户取消后保留已收到的部分正文，并展示取消状态。
- 流式失败后保留已收到的部分正文，并展示错误提示。
- 失败后不自动重试。
- WebSocket 消息 IDL schema 放在 `@kimiko/schema`，前后端共享。
- 验证范围为 `typecheck`、`lint`、`build`。

## 现有前端约束
- 前端使用 React、react-router、Tailwind CSS。
- API base URL 来自 `VITE_API_BASE_URL`。
- 登录态保存在 `localStorage`，通过 `getStoredAuthSession()` 读取。
- 本地登录态失效时，页面跳转 `/login`。
- 共享契约使用 `@kimiko/schema` 的 zod schema 和类型。
- TypeScript 文件必须保持严格类型安全，避免 `any`。
- 非原始值 `useState` 必须显式标注泛型。
- 本期不新增前端第三方依赖。

## IDL Schema
WebSocket 消息 schema 放在 `packages/schema/src/index.ts`。

### 客户端消息

```ts
export const StoryRealtimeRequestIdSchema = z.string().trim().min(1);

export const StoryContinueClientMessageSchema = z
  .object({
    type: z.literal("story.continue"),
    requestId: StoryRealtimeRequestIdSchema,
    payload: ContinueStoryRequestSchema,
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

### 服务端事件

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
    continuedStory: z.string().trim().min(1),
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
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
- 客户端发送消息前应使用 schema 或 `satisfies` 保证结构符合契约。
- 前端收到服务端消息后必须用 `StoryRealtimeServerEventSchema.safeParse` 做运行时校验。
- 收到无法解析或不符合 schema 的服务端消息时，视为生成失败。

## 文件组织
新增或调整以下文件：

- `packages/web/src/story/storyRealtimeApi.ts`
  - 负责 WebSocket URL 推导、鉴权 token 拼接、建连、发送 `story.continue`、处理服务端事件、取消和关闭连接。
- `packages/web/src/story/storyApi.ts`
  - 删除非流式 HTTP 客户端。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 从 HTTP 提交状态改为流式状态机。
  - 负责字段校验、发起流式生成、追加正文、取消、错误和完成元数据。
- `packages/web/src/pages/story/StoryForm.tsx`
  - 支持生成中按钮文案变为 `取消生成`。
  - 生成中点击按钮触发取消，而不是提交。
- `packages/web/src/pages/story/StoryResult.tsx`
  - 支持展示流式中的部分正文。
  - completed 前不展示模型、耗时、Token。
  - cancelled/failed 时展示状态提示。
- `packages/schema/src/index.ts`
  - 增加 WebSocket 消息 IDL schema。

## WebSocket URL 推导
从 `VITE_API_BASE_URL` 推导 WebSocket base：

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

建连时追加 token：

```ts
const url = new URL(getRealtimeBaseUrl(API_BASE_URL));
url.searchParams.set("accessToken", authSession.session.accessToken);
const socket = new WebSocket(url);
```

说明：
- 本地 `http://localhost:3000` 推导为 `ws://localhost:3000/realtime`。
- 生产 `https://api.example.com` 推导为 `wss://api.example.com/realtime`。
- 不新增 `VITE_WS_BASE_URL`。

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
  request: ContinueStoryRequest,
  callbacks: StoryRealtimeGenerationCallbacks,
): StoryRealtimeGenerationHandle;
```

处理规则：
- 调用时读取 `getStoredAuthSession()`。
- session 不存在或失效时，不建连，直接触发 `onAuthRequired`。
- 建连成功后发送 `story.continue`。
- `requestId` 使用 `crypto.randomUUID()` 生成。
- 收到不同 `requestId` 的服务端事件时忽略。
- 收到 `story.started` 后触发 `onStarted`。
- 收到 `story.chunk` 后触发 `onChunk(delta, sequence)`。
- 收到 `story.completed` 后触发 `onCompleted(event)` 并关闭连接。
- 收到 `story.cancelled` 后触发 `onCancelled()` 并关闭连接。
- 收到 `story.error` 后触发 `onError(event.message)` 并关闭连接。
- 收到无法解析的消息时触发 `onError("生成失败，请稍后重试")` 并关闭连接。
- WebSocket `close` 如果发生在未完成、未取消、未失败状态，视为生成失败。
- WebSocket `error` 统一视为生成失败。

取消规则：
- `cancel()` 发送 `story.cancel`。
- 如果 socket 还未 open，则直接关闭 socket 并触发取消状态。
- `close()` 用于组件卸载清理，不触发 UI 状态回调。

## 页面状态模型
`StoryPage` 使用本地状态，不引入全局 Store，不写 localStorage，不保留历史列表。

```ts
type StoryGenerationStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "completed"
  | "cancelled"
  | "failed";

interface StoryStreamingResult {
  continuedStory: string;
  model?: string;
  elapsedMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}
```

状态规则：
- 初始状态为 `idle`，不展示结果区。
- 点击生成后先做字段校验。
- 校验失败时不建连，只展示字段级错误。
- 校验通过后清空旧结果和旧错误，进入 `connecting`。
- 收到 `story.started` 后进入 `streaming`。
- 收到 `story.chunk` 后追加 `continuedStory`。
- 收到 `story.completed` 后进入 `completed`，写入最终正文、模型、耗时和 Token。
- 用户点击取消后发送 `story.cancel`。
- 收到 `story.cancelled` 后进入 `cancelled`，保留已收到正文。
- 收到错误或连接异常后进入 `failed`，保留已收到正文。
- 再次点击生成时清空旧结果并开启新连接。
- 组件卸载时关闭当前连接，不更新 UI 状态。

## UI 行为
- 页面仍只展示故事正文输入、续写指令输入、主按钮和结果区。
- 未开始生成时，主按钮文案为 `生成续写`。
- `connecting` / `streaming` 时，主按钮文案为 `取消生成`。
- `connecting` / `streaming` 时，两个 textarea 暂时不可编辑。
- 结果区在收到第一个 chunk 时出现。
- `streaming` 中结果正文实时增长，保留换行。
- `completed` 后在正文下方展示：`模型：{model} / 耗时：{elapsedMs}ms / Token：{usage.totalTokens}`。
- `cancelled` 时，在结果区下方显示 `已取消生成`。
- `failed` 时，在结果区下方显示错误文案，默认 `生成失败，请稍后重试`。
- 失败和取消都不清空输入。
- 失败和取消都保留已经收到的部分正文。
- 不自动重试。
- 不提供复制、保存、导出、结果对比。

## 鉴权行为
- 页面仍由 `RequireAuth` 保护。
- 发起 WebSocket 前再次通过 `getStoredAuthSession()` 读取登录态。
- 登录态不存在或失效时跳转 `/login`。
- WebSocket 建连被服务端关闭且 close code 为 `1008` 时，清理本地登录态并跳转 `/login`。
- 其他 close/error 视为生成失败，不跳转登录。

## 与 002 非流式实现的关系
- 本期删除前端非流式 `continueStory` HTTP 客户端。
- 后端保留 `POST /story/continue`，但前端 Story 页面不再调用它。
- `StoryResult` 从依赖 `ContinueStoryResponse` 改为依赖页面本地的 `StoryStreamingResult`。
- 002 的输入校验、字段提示、受保护首页、元数据展示规则继续保留。

## 测试与验证
本期不新增前端测试框架。实现完成后执行：

```bash
pnpm --filter @kimiko/schema build
pnpm --filter @kimiko/schema typecheck
pnpm --filter @kimiko/schema lint
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```

人工验收：
- 登录后访问 `/`。
- 填写故事正文和续写指令。
- 点击生成后按钮变为 `取消生成`，输入框禁用。
- 服务端返回 chunk 时，结果正文即时增长。
- 完成后展示模型、耗时、Token。
- 生成中点击取消，结果保留部分正文并显示已取消。
- 流式失败时保留部分正文并显示错误。
- 登录态失效时跳转 `/login`。

## 本期不做
- 不做非流式/流式切换。
- 不做 HTTP fallback。
- 不做自动重试。
- 不做断线重连恢复。
- 不做历史结果列表。
- 不做多任务并发。
- 不做全局 WebSocket 连接。
- 不新增前端第三方依赖。
