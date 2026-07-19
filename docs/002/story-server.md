# StoryAgent 后端技术方案

## 背景
本文档对应 PRD：[story.md](./story.md) 和前端技术方案：[story-fe.md](./story-fe.md)。

本轮后端目标是提供 StoryAgent 领域接口，让前端通过一次请求完成故事续写：提交故事正文和续写指令，后端构造稳定提示词，调用现有 LLM 能力，并返回续写正文、模型、耗时和 Token 用量。

## IDL 结论
已读取 `story-fe.md` 中的 IDL Schema。本轮后端沿用前端技术方案中的 IDL，不需要修改，因此不额外输出 `story-fe-idl-change.md`。

后端需要在 `packages/schema/src/index.ts` 中补充并使用以下共享契约：

```ts
export const ContinueStoryRequestSchema = z
  .object({
    storyText: z.string().trim().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type ContinueStoryRequest = z.infer<
  typeof ContinueStoryRequestSchema
>;

export const ContinueStoryUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

export type ContinueStoryUsage = z.infer<typeof ContinueStoryUsageSchema>;

export const ContinueStoryResponseSchema = z
  .object({
    continuedStory: z.string().trim().min(1),
    model: z.string().trim().min(1),
    elapsedMs: z.number().int().nonnegative(),
    usage: ContinueStoryUsageSchema,
  })
  .strict();

export type ContinueStoryResponse = z.infer<
  typeof ContinueStoryResponseSchema
>;
```

接口契约：
- `POST /story/continue`
- 请求体：`ContinueStoryRequest`
- 响应体：`ContinueStoryResponse`
- 必须登录，请求需要通过现有 `JwtAuthGuard`。

## 已确认决策
- 新增 Story 领域接口，不让前端直接拼接 LLM prompt。
- 新增 `StoryModule`，不并入 `LlmModule`。
- `StoryService` 复用现有 `LlmService`。
- `elapsedMs` 仅统计后端调用 LLM 的耗时。
- 底层 LLM 响应缺失 `usage` 时，Story 接口生成失败，不返回伪造 Token。
- LLM 返回空文本时，Story 接口生成失败。
- 800-1200 字要求通过提示词约束，不做后端硬截断。
- 不保存故事正文、续写指令、生成结果或历史记录。
- 不使用当前登录用户信息做个性化，只做接口鉴权。
- 现有 `/llm/generate` 保持不变。
- 本轮不新增第三方依赖，不新增数据库表，不新增迁移。

## 模块设计
新增文件：

- `packages/server/src/story/story.module.ts`
  - 引入 `LlmModule`。
  - 注册 `StoryController` 和 `StoryService`。
- `packages/server/src/story/story.controller.ts`
  - 暴露 `POST /story/continue`。
  - 使用 `JwtAuthGuard`。
  - 接收 `unknown` body，交给 service 做 schema 解析。
- `packages/server/src/story/story.service.ts`
  - 使用 `ContinueStoryRequestSchema.safeParse` 校验请求。
  - 构造 StoryAgent 提示词。
  - 调用 `LlmService.generateText`。
  - 校验 LLM 返回内容、usage 和模型信息。
  - 映射为 `ContinueStoryResponse`。
- `packages/server/src/story/story.service.spec.ts`
  - 覆盖请求校验、prompt 构造、响应映射、usage 缺失、空文本等核心逻辑。
- `packages/server/test/story.e2e-spec.ts`
  - 覆盖鉴权、成功链路、非法请求、LLM 未配置或失败等 HTTP 行为。

调整文件：

- `packages/server/src/app.module.ts`
  - 导入 `StoryModule`。
- `packages/schema/src/index.ts`
  - 增加 Story IDL schema。

## 控制器设计
`StoryController` 只承担 HTTP 边界职责：

```ts
@Controller("story")
export class StoryController {
  constructor(private readonly storyService: StoryService) {}

  @Post("continue")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  continue(@Body() body: unknown): Promise<ContinueStoryResponse> {
    return this.storyService.continueStory(body);
  }
}
```

说明：
- controller 不解析字段、不拼 prompt、不处理 LLM 细节。
- controller 不读取 `request.user`，登录态只用于访问控制。
- 非法 token、缺失 token 等行为沿用现有 `JwtAuthGuard`。

## Service 设计
`StoryService` 对外暴露：

```ts
async continueStory(body: unknown): Promise<ContinueStoryResponse>
```

处理流程：
1. 使用 `ContinueStoryRequestSchema.safeParse(body)` 校验请求。
2. 校验失败时返回 `BadRequestException`，错误信息包含首个字段路径。
3. 使用 trim 后的 `storyText` 和 `instruction` 构造 LLM 请求。
4. 在调用 `llmService.generateText` 前记录开始时间。
5. 等待 LLM 返回。
6. 记录结束时间，得到 `elapsedMs`。
7. 校验 `text` 非空。
8. 校验 `usage` 存在，且包含 `inputTokens`、`outputTokens`、`totalTokens`。
9. 返回 `ContinueStoryResponse`。

响应映射：
- `continuedStory` 取 LLM 返回 `text` 的 trim 结果。
- `model` 取 LLM 返回 `model`。
- `elapsedMs` 取本次 LLM 调用耗时。
- `usage` 取 LLM 返回 usage。

## Prompt 设计
使用固定 system prompt 加结构化 user prompt。

system prompt 负责稳定 StoryAgent 行为：

```text
你是 StoryAgent，负责根据用户提供的故事正文和续写指令生成故事续写。
你必须只输出新生成的续写正文，不要重复用户输入的故事正文。
续写正文需要承接原文已有的人物、事件、语气和上下文。
续写正文需要遵循用户的续写指令，体现主要情节和人物行动。
输出目标长度为 800-1200 字。
输出语言必须跟随故事正文的主要语言。
不要输出标题、解释、列表、调试信息或“以下是续写”等前缀。
```

user prompt 使用明确分段，避免把正文和指令混在一起：

```text
故事正文：
{storyText}

续写指令：
{instruction}
```

说明：
- 后端不允许前端传入 system prompt。
- 后端不允许前端传入模型、温度、max token 等生成参数。
- 字数要求只通过提示词约束，不做字符串截断。

## 错误处理
请求校验错误：
- `storyText` 缺失、空字符串、超长时返回 `400`。
- `instruction` 缺失、空字符串、超长时返回 `400`。
- 请求体包含未声明字段时返回 `400`。

LLM 失败：
- 保留现有 `LlmService` 和 provider 的 Nest 异常映射。
- 上游空响应、无 choices 等继续映射为 `502`。
- 上游超时继续映射为 `504`。
- 上游不可用、限流、鉴权失败等继续映射为 `503`。

Story 映射失败：
- LLM 返回空 `text` 时返回 `502`。
- LLM 返回缺失 `usage` 或 usage 字段不完整时返回 `502`。
- 不伪造 Token 数据，不返回部分成功结果。

前端会统一展示固定文案 `生成失败，请稍后重试`，后端仍保留准确 HTTP 状态，方便服务端测试和排查。

## 鉴权与状态
- `POST /story/continue` 必须使用 `JwtAuthGuard`。
- 后端只验证登录态，不读取或使用 `userId`。
- 不写数据库。
- 不保存请求、响应、历史消息或生成状态。
- 不做多轮上下文，不读取历史记录。
- 不实现流式输出。

## 测试方案
### 单元测试
`story.service.spec.ts` 覆盖：
- trim 后的 `storyText` 和 `instruction` 被正确传入 prompt。
- 生成请求包含固定 system prompt。
- 成功时返回 `continuedStory`、`model`、`elapsedMs`、`usage`。
- `elapsedMs` 为非负整数。
- 空 `storyText` 返回 `BadRequestException`。
- 空 `instruction` 返回 `BadRequestException`。
- 额外字段返回 `BadRequestException`。
- LLM 返回缺失 `usage` 时抛出 `BadGatewayException`。
- LLM 返回空文本时抛出 `BadGatewayException`。
- LLM 异常不被吞掉，按原异常传播。

### E2E 测试
`story.e2e-spec.ts` 覆盖：
- 未登录请求 `POST /story/continue` 返回 `401`。
- 登录后非法请求返回 `400`。
- 登录后成功请求返回符合 `ContinueStoryResponseSchema` 的响应。
- 测试中通过 override `LLM_PROVIDER` 隔离真实 LLM 网络调用。
- provider 未配置或失败时，Story 接口返回对应错误状态。
- 成功链路断言 provider 收到的 prompt 包含故事正文、续写指令和 StoryAgent 输出约束。

## 验证命令
实现完成后执行：

```bash
pnpm --filter @kimiko/server typecheck
pnpm --filter @kimiko/server lint
pnpm --filter @kimiko/server test
pnpm --filter @kimiko/server test:e2e
```

如 schema 变更影响前端，也需要执行：

```bash
pnpm --filter @kimiko/web typecheck
```
