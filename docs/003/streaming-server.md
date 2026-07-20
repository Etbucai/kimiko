# 流式输出后端技术方案

## 背景
本文档对应 PRD：[streaming.md](./streaming.md)，并依赖上一期故事续写能力：[../002/story-server.md](../002/story-server.md)。

本期目标是在服务端建立 `realtime` 模块，通过原生 WebSocket 让 StoryAgent 的故事续写支持流式输出。现有非流式接口 `POST /story/continue` 保持不变，本期新增实时通道，不破坏 002 已完成的 HTTP 能力。

## 前端 IDL 结论
当前 `docs/003` 下没有独立前端技术方案文件，因此不存在需要读取并修改的 `streaming-fe.md` IDL schema。本服务端技术方案直接定义 WebSocket 消息契约，后续前端技术方案应复用本文档中的消息 schema。

本期不生成 `streaming-fe-idl-change.md`。

## 已确认决策
- 使用原生 WebSocket，不使用 Socket.IO，不使用 SSE。
- 服务端新增 `RealtimeModule`。
- WebSocket 路径为 `/realtime`。
- 建连鉴权使用查询参数 `accessToken`，例如：`ws://localhost:3000/realtime?accessToken=...`。
- 鉴权复用现有 JWT 校验逻辑。
- Story 流式续写采用请求-事件流协议。
- 单个 WebSocket 连接同一时间只允许一个活跃 Story 生成任务。
- 客户端请求必须携带 `requestId`，服务端所有任务事件回传同一个 `requestId`。
- 文本 chunk 使用增量 `delta`，前端自行拼接。
- 客户端主动取消使用 `story.cancel` 消息。
- 客户端断开连接时，服务端必须取消正在进行的上游 LLM 流。
- 完成事件必须包含模型、耗时和 Token usage。
- 如果底层 LLM 流式响应缺失 usage，服务端发送错误事件，不发送 completed。
- 错误事件只暴露稳定错误码和通用文案，不透传 provider 技术细节。
- 现有 `POST /story/continue` 非流式接口保持不变。

## 新增依赖
当前服务端尚未安装 WebSocket 相关 Nest 依赖。实现时需要新增：

- `@nestjs/websockets`
- `@nestjs/platform-ws`
- `ws`
- `@types/ws`

依赖版本必须通过 `pnpm-workspace.yaml` 的 `catalog` 管理，`packages/server/package.json` 中使用 `catalog:` 引用。`@types/ws` 放在 `devDependencies`，其余放在 `dependencies`。

## 模块设计
新增文件：

- `packages/server/src/realtime/realtime.module.ts`
  - 注册 `RealtimeGateway`。
  - 引入 `StoryModule`。
- `packages/server/src/realtime/realtime.gateway.ts`
  - 处理 WebSocket 连接、鉴权、消息解析、任务状态、取消和断连清理。
- `packages/server/src/realtime/realtime.types.ts`
  - 定义服务端内部 WebSocket 消息类型、错误码和活跃任务状态。
- `packages/server/src/realtime/realtime.gateway.spec.ts`
  - 覆盖消息解析、鉴权失败、单连接 busy、取消、错误事件等逻辑。
- `packages/server/test/realtime.e2e-spec.ts`
  - 使用 `ws` 客户端验证真实 WebSocket 通道。

需要调整：

- `packages/server/src/main.ts`
  - 注册 `WsAdapter`。
- `packages/server/src/app.module.ts`
  - 导入 `RealtimeModule`。
- `packages/server/src/story/story.module.ts`
  - 导出 `StoryService`，供 `RealtimeModule` 复用 StoryAgent prompt 和流式生成能力。
- `packages/server/src/story/story.service.ts`
  - 增加 Story 流式续写方法，复用现有 `ContinueStoryRequestSchema` 和 `buildStoryLlmRequest`。
- `packages/server/src/llm/llm.provider.ts`
  - 扩展 provider 抽象，增加流式文本生成接口。
- `packages/server/src/llm/openai-compatible.provider.ts`
  - 实现 OpenAI-compatible chat completions streaming。
- `packages/server/src/llm/llm.providers.ts`
  - 未配置 LLM provider 时，流式接口同样返回 `ServiceUnavailableException`。

## WebSocket 启动配置
在 `main.ts` 中注册 `WsAdapter`：

```ts
import { WsAdapter } from "@nestjs/platform-ws";

const app = await NestFactory.create(AppModule);
app.useWebSocketAdapter(new WsAdapter(app));
configureApp(app);
await app.listen(Env.port);
```

说明：
- HTTP CORS 仍由 `configureApp` 负责。
- WebSocket 鉴权不依赖 HTTP CORS。
- WebSocket 连接必须在 gateway 层校验 `accessToken`。

## 鉴权设计
建连 URL：

```text
ws://localhost:3000/realtime?accessToken={accessToken}
```

处理流程：
1. `RealtimeGateway.handleConnection` 读取请求 URL 中的 `accessToken`。
2. 缺失 token 时关闭连接，关闭码使用 `1008`。
3. token 非法或过期时关闭连接，关闭码使用 `1008`。
4. token 合法时，在连接上下文中记录 `userId` 和 `uniqueName`。

鉴权只用于访问控制：
- 不把用户信息传入 prompt。
- 不保存用户输入、输出或历史消息。
- 不写数据库。

## WebSocket 消息契约
所有消息均为 JSON 字符串。服务端收到非法 JSON 时返回 `story.error`，如果无法解析出 `requestId`，则 `requestId` 为空字符串。

### 客户端消息：开始续写

```ts
type StoryContinueClientMessage = {
  type: "story.continue";
  requestId: string;
  payload: {
    storyText: string;
    instruction: string;
  };
};
```

校验规则：
- `requestId` 必须为非空字符串。
- `payload` 必须符合现有 `ContinueStoryRequestSchema`。
- 当前连接已有活跃任务时，服务端返回 `BUSY` 错误。

### 客户端消息：取消续写

```ts
type StoryCancelClientMessage = {
  type: "story.cancel";
  requestId: string;
};
```

处理规则：
- `requestId` 必须匹配当前活跃任务。
- 匹配时中止上游 LLM 请求，并发送 `story.cancelled`。
- 不匹配时返回 `NO_ACTIVE_TASK` 错误。

### 服务端事件：开始

```ts
type StoryStartedServerEvent = {
  type: "story.started";
  requestId: string;
};
```

服务端在请求校验通过、准备调用 LLM 前发送。

### 服务端事件：文本增量

```ts
type StoryChunkServerEvent = {
  type: "story.chunk";
  requestId: string;
  sequence: number;
  delta: string;
};
```

规则：
- `sequence` 从 `1` 开始递增。
- `delta` 只包含本次新增文本。
- 空 `delta` 不发送。

### 服务端事件：完成

```ts
type StoryCompletedServerEvent = {
  type: "story.completed";
  requestId: string;
  continuedStory: string;
  model: string;
  elapsedMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};
```

规则：
- `continuedStory` 为服务端累计的完整续写正文。
- `elapsedMs` 只统计 LLM 流式调用耗时。
- `usage` 必须来自 provider 流式响应。
- 如果没有收到任何有效文本，发送 `LLM_EMPTY_RESPONSE` 错误，不发送 completed。
- 如果 provider 未返回完整 usage，发送 `LLM_USAGE_MISSING` 错误，不发送 completed。

### 服务端事件：取消

```ts
type StoryCancelledServerEvent = {
  type: "story.cancelled";
  requestId: string;
};
```

取消后当前连接回到空闲状态，可以继续发送新的 `story.continue`。

### 服务端事件：错误

```ts
type StoryErrorServerEvent = {
  type: "story.error";
  requestId: string;
  code:
    | "INVALID_MESSAGE"
    | "INVALID_PAYLOAD"
    | "BUSY"
    | "NO_ACTIVE_TASK"
    | "GENERATION_FAILED"
    | "LLM_EMPTY_RESPONSE"
    | "LLM_USAGE_MISSING";
  message: string;
  retryable: boolean;
};
```

错误文案使用稳定通用文案：
- `INVALID_MESSAGE`：`消息格式不正确`
- `INVALID_PAYLOAD`：`请求参数不正确`
- `BUSY`：`当前连接已有生成任务`
- `NO_ACTIVE_TASK`：`当前没有可取消的生成任务`
- `GENERATION_FAILED`：`生成失败，请稍后重试`
- `LLM_EMPTY_RESPONSE`：`生成结果为空，请稍后重试`
- `LLM_USAGE_MISSING`：`生成元数据缺失，请稍后重试`

## LLM 流式抽象
在 `LlmProvider` 中新增流式接口：

```ts
export type LlmTextStreamEvent =
  | Readonly<{ type: "chunk"; delta: string }>
  | Readonly<{
      type: "completed";
      model: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }>;

export interface LlmProvider {
  generateText(input: GenerateLlmTextRequest): Promise<GenerateLlmTextResponse>;

  streamText(
    input: GenerateLlmTextRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncIterable<LlmTextStreamEvent>;
}
```

`LlmService` 增加：

```ts
streamTextFromParsedRequest(
  request: GenerateLlmTextRequest,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<LlmTextStreamEvent>
```

说明：
- 非流式 `generateText` 保持不变。
- 流式接口同样复用 `GenerateLlmTextRequest`，不允许前端传入模型、温度、max token。
- `AbortSignal` 用于客户端取消和断连取消。

## OpenAI-compatible provider 流式实现
`OpenAiCompatibleProvider.streamText` 使用 chat completions streaming：

```ts
client.chat.completions.create(
  {
    model: config.model,
    messages: buildChatCompletionMessages(input),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  },
  {
    signal,
  },
);
```

映射规则：
- 每个 chunk 的 `choices[0].delta.content` 非空时，产出 `type: "chunk"`。
- 记录最后出现的 `model`。
- 从包含 usage 的 chunk 中读取 token 用量。
- 流结束后，如果 usage 完整，产出 `type: "completed"`。
- 流结束后，如果 usage 缺失或不完整，抛出 `BadGatewayException`。
- 上游超时、连接错误、鉴权失败、限流等继续复用现有错误映射策略。
- `AbortError` 由调用方识别为取消，不映射为普通生成失败。

## Story 流式服务
`StoryService` 增加：

```ts
streamContinueStory(
  body: unknown,
  options: Readonly<{ signal: AbortSignal }>,
): AsyncIterable<StoryStreamEvent>
```

处理流程：
1. 使用 `ContinueStoryRequestSchema.safeParse(body)` 校验请求。
2. 复用现有 `buildStoryLlmRequest` 构造固定 system prompt 和结构化 user prompt。
3. 调用 `llmService.streamTextFromParsedRequest`。
4. 累计所有文本 delta，形成 `continuedStory`。
5. 向 realtime gateway 逐个产出 chunk。
6. LLM completed 后校验累计正文非空。
7. 返回最终 `continuedStory`、`model`、`elapsedMs`、`usage`。

`elapsedMs` 口径：
- 从开始调用 LLM stream 到收到 LLM completed 事件。
- 不包含 WebSocket 建连、客户端消息解析和发送 completed 事件后的清理时间。

## RealtimeGateway 任务状态
每个已鉴权连接维护一个本地活跃任务：

```ts
type ActiveRealtimeTask = {
  requestId: string;
  abortController: AbortController;
};
```

状态规则：
- 初始无活跃任务。
- 收到合法 `story.continue` 后创建活跃任务。
- 活跃任务存在时再次收到 `story.continue`，返回 `BUSY`。
- 收到匹配的 `story.cancel` 时调用 `abortController.abort()`，发送 `story.cancelled`。
- 连接断开时，如果存在活跃任务，调用 `abortController.abort()`。
- completed、error、cancelled 后清空活跃任务。

## 错误处理
握手阶段：
- 缺失或非法 token：关闭连接，code `1008`，reason `Unauthorized`。

消息阶段：
- 非 JSON 或不符合消息结构：发送 `INVALID_MESSAGE`。
- `story.continue` payload 校验失败：发送 `INVALID_PAYLOAD`。
- 当前连接已有活跃任务：发送 `BUSY`。
- LLM provider 异常：发送 `GENERATION_FAILED`。
- LLM 空输出：发送 `LLM_EMPTY_RESPONSE`。
- LLM usage 缺失：发送 `LLM_USAGE_MISSING`。

服务端日志：
- 可以记录错误类型和 requestId。
- 不记录完整故事正文、续写指令或完整模型输出。

## 测试方案
### 单元测试
覆盖：
- `RealtimeGateway` 缺失 token 时关闭连接。
- 非法 token 时关闭连接。
- 非法 JSON 返回 `INVALID_MESSAGE`。
- payload 不符合 `ContinueStoryRequestSchema` 返回 `INVALID_PAYLOAD`。
- 单连接已有任务时返回 `BUSY`。
- `story.cancel` 能触发 `AbortController.abort()` 并发送 `story.cancelled`。
- 断连时能触发 `AbortController.abort()`。
- chunk 事件按顺序发送 `sequence` 和 `delta`。
- usage 缺失时发送 `LLM_USAGE_MISSING`。
- 空输出时发送 `LLM_EMPTY_RESPONSE`。

### Provider 单元测试
覆盖：
- OpenAI streaming delta 被映射为 `LlmTextStreamEvent` chunk。
- stream usage 被映射为 completed usage。
- usage 缺失时抛出 `BadGatewayException`。
- provider 侧连接错误、超时、限流等继续映射为现有 Nest 异常。
- abort signal 生效时中止上游请求。

### E2E 测试
使用 `ws` 客户端覆盖：
- 未携带 token 建连失败。
- 非法 token 建连失败。
- 合法 token 建连成功。
- 发送 `story.continue` 后收到 `story.started`、多个 `story.chunk`、`story.completed`。
- `story.completed` 包含完整 `continuedStory`、`model`、`elapsedMs`、`usage`。
- 发送第二个并发 `story.continue` 返回 `BUSY`。
- 发送 `story.cancel` 后收到 `story.cancelled`。
- 测试中 override `LLM_PROVIDER`，不调用真实 LLM 网络。

## 验证命令
实现完成后执行：

```bash
pnpm --filter @kimiko/schema build
pnpm --filter @kimiko/schema typecheck
pnpm --filter @kimiko/schema lint
pnpm --filter @kimiko/server typecheck
pnpm --filter @kimiko/server lint
pnpm --filter @kimiko/server test
pnpm --filter @kimiko/server test:e2e
```

如果前端同步接入流式通道，还需要执行：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```

## 本期不做
- 不做 Socket.IO。
- 不做 SSE。
- 不做多任务并发。
- 不做断线重连恢复。
- 不保存流式历史。
- 不把用户输入、输出写入数据库。
- 不做跨进程任务恢复。
- 不做房间、广播或多人协同。
- 不移除现有非流式 `POST /story/continue`。
