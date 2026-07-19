# StoryAgent 前端技术方案

## 背景
本文档对应 PRD：[story.md](./story.md)。

本轮只覆盖 StoryAgent 的前端技术方案，目标是让内部测试者在登录后的首页完成一次故事续写：填写故事正文和续写指令，触发生成，看到续写正文以及模型、耗时、Token 元数据。

## 已确认决策
- StoryAgent 页面挂载在 `/`，替换当前首页占位。
- `/` 继续使用现有 `RequireAuth` 保护。
- 页面组件采用“页面 + 子组件”结构。
- Story API 调用封装在 `packages/web/src/story/storyApi.ts`。
- API 契约使用 Story 领域 IDL，不让页面层直接拼装 LLM prompt。
- 生成失败展示固定通用文案：`生成失败，请稍后重试`。
- 字段校验在点击提交后触发，按 trim 后非空判断。
- 生成中禁用两个输入区域和生成按钮。
- 每次提交时清空旧结果；如果本次失败，不恢复旧结果。
- 结果区展示续写正文，并在正文下方以紧凑信息行展示模型、耗时、Token。
- 验证范围为 `typecheck`、`lint`、`build`。

## 现有前端约束
- 前端使用 React、react-router、Tailwind CSS。
- 受保护路由通过 `RequireAuth` 组件包裹。
- API base URL 来自 `VITE_API_BASE_URL`。
- 跨包请求/响应类型与运行时校验放在 `@kimiko/schema`。
- TypeScript 文件必须保持严格类型安全，避免 `any`，非原始值 `useState` 需要显式泛型。
- 本轮不新增第三方依赖。

## 文件组织
计划新增或调整以下前端文件：

- `packages/web/src/pages/story/StoryPage.tsx`
  - 页面容器，负责表单状态、字段校验、提交、loading、错误、结果状态和登录失效跳转。
- `packages/web/src/pages/story/StoryForm.tsx`
  - 受控表单组件，渲染故事正文、续写指令和生成按钮。
- `packages/web/src/pages/story/StoryResult.tsx`
  - 结果组件，渲染续写正文和模型、耗时、Token 元数据。
- `packages/web/src/story/storyApi.ts`
  - Story API 客户端，负责读取本地 session、发送鉴权请求、解析响应 schema、归一错误。
- `packages/web/src/App.tsx`
  - 将 `/` 路由的元素从当前首页占位替换为 `StoryPage`。

可选处理：
- 当前 `packages/web/src/pages/HomePage.tsx` 仅为占位页面。实现时可以删除，也可以保留但不再接入路由。

## IDL Schema
StoryAgent 使用独立领域契约。前端技术方案要求在 `packages/schema/src/index.ts` 中补充以下 schema，并由前端通过 `@kimiko/schema` 引用。

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

字段说明：
- `storyText`：用户输入的故事正文，提交前 trim，最大 20000 字符。
- `instruction`：用户输入的续写指令，提交前 trim，最大 8000 字符。
- `continuedStory`：本次生成的续写正文，不包含用户原文。
- `model`：服务端实际使用的模型名称。
- `elapsedMs`：服务端返回的生成耗时，单位毫秒。
- `usage`：Token 用量，复用现有 LLM usage 语义。

接口假设：
- `POST /story/continue`
- 请求体：`ContinueStoryRequest`
- 响应体：`ContinueStoryResponse`
- 前端必须用 `ContinueStoryResponseSchema.parse` 校验响应。

## 页面状态模型
`StoryPage` 使用组件本地状态，不使用全局 Store，不写入 localStorage，不保留历史结果。

```ts
type StoryGenerationStatus = "idle" | "submitting" | "succeeded" | "failed";

interface StoryFormState {
  storyText: string;
  instruction: string;
}

interface StoryFieldErrors {
  storyText?: string;
  instruction?: string;
}
```

状态规则：
- 初始状态为 `idle`，没有结果区，没有错误提示。
- 点击生成后先校验字段。
- 字段为空时不发请求，只展示对应字段级错误。
- 校验通过后进入 `submitting`，清空旧结果和旧错误。
- `submitting` 期间禁用两个 textarea 和生成按钮。
- 成功后进入 `succeeded`，展示本次结果。
- 失败后进入 `failed`，展示固定失败文案，不恢复旧结果。
- 用户修改某个字段后，可以清除该字段的字段级错误。

## API 调用方案
`storyApi.ts` 暴露：

```ts
export async function continueStory(
  request: ContinueStoryRequest,
): Promise<ContinueStoryResponse>;
```

调用规则：
- 通过 `getStoredAuthSession()` 获取当前 session。
- session 不存在或已失效时，不发送请求，由页面跳转 `/login`。
- 请求头包含：
  - `Content-Type: application/json`
  - `Authorization: Bearer ${accessToken}`
- 响应成功后使用 `ContinueStoryResponseSchema.parse` 做运行时校验。
- 网络失败、非 2xx、响应 schema 不合法，统一作为生成失败处理。
- 页面不透传服务端技术错误，只展示固定文案。
- 如果服务端返回 401，清理本地登录态并跳转 `/login`。

## 交互细节
- 页面只展示故事正文输入、续写指令输入、生成按钮。
- 初始不展示结果区。
- 故事正文和续写指令使用 textarea。
- 字段级错误只在用户点击生成后出现。
- 生成按钮文案：
  - 默认：`生成续写`
  - 生成中：`生成中...`
- 成功结果包含两部分：
  - 续写正文
  - 正文下方紧凑元数据行：`模型：{model} / 耗时：{elapsedMs}ms / Token：{usage.totalTokens}`
- 页面不提供复制、清空、收藏、保存、导出、结果对比等操作。

## 样式方案
- 使用 Tailwind utility classes，不新增 CSS 依赖。
- 页面采用移动端优先的单列布局。
- 主体内容宽度做上限约束，避免桌面端行宽过长。
- 表单和结果区使用清晰的视觉分组。
- 结果正文保持可阅读排版，保留换行。
- 元数据行使用小字号和弱化颜色，不抢占正文阅读焦点。
- 复用现有全局 CSS 变量，如 `--bg`、`--panel-bg`、`--border`、`--text`、`--text-h`、`--accent`、`--danger`。

## 验收标准
- 登录用户访问 `/` 时看到 StoryAgent 页面。
- 未登录或本地 session 失效时访问 `/` 会进入登录流程。
- 页面初始只展示两个输入和生成按钮，不展示结果区。
- 点击生成时，如果故事正文为空，故事正文字段附近展示错误。
- 点击生成时，如果续写指令为空，续写指令字段附近展示错误。
- 输入校验通过后，页面发送 Story 领域请求。
- 生成期间输入和按钮不可用，按钮展示 `生成中...`。
- 生成成功后展示续写正文。
- 续写正文下方展示模型、耗时、Token。
- 再次提交会先清空旧结果；新结果成功后覆盖展示。
- 再次提交失败时，只展示失败提示，不恢复旧结果。
- 生成失败时保留用户当前输入。

## 验证命令
实现完成后执行：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```
