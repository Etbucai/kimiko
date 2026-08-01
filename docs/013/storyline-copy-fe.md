# 复制故事前端技术方案

## 背景

本文档对应 PRD：[storyline-copy-prd.md](./storyline-copy-prd.md)。

013 的产品目标是：用户可以在故事详情页指定截止章节 N，把原故事第 1 章到第 N 章复制为一个完全独立的新故事。用户在复制时填写新标题，复制成功后直接进入新故事最后一章继续创作。

复制不涉及 LLM 流式生成，前端使用普通 HTTP 请求完成创建，不复用 `story.continue` WebSocket。

## 已确认决策

- 复制入口位于故事详情页顶部「更多」菜单。
- 顶部直接展示当前故事标题。
- 「更多」菜单包含「复制故事」和「上下文」。
- 「上下文」替代现有「调试」文案，路由行为不变。
- 复制弹窗默认使用当前阅读章节作为 N。
- 用户可以在 `1..chapterCount` 范围内修改 N。
- 新故事标题默认是「原标题（副本）」，用户可以修改。
- 标题去除首尾空白后长度为 1 到 80 个字符。
- 标题允许重复。
- 提交期间禁用重复点击，不实现服务端严格幂等。
- 复制失败时保持弹窗打开并保留表单值。
- 复制成功后跳转新故事详情，并显示「已复制前 N 章」Toast。
- 源故事正在本页生成时禁用复制。
- 后台上下文提取等无法仅靠本地状态判断的冲突，以服务端 `409` 为准。
- 服务端只复用不超过 N 的最近安全上下文；若安全快照早于 N，保留待提取轮次，不由复制页面触发 LLM 补提取。

## 非目标

- 不修改现有续写、重写和互动的 WebSocket 协议。
- 不在故事列表新增复制入口。
- 不提供故事标题编辑页面或重命名入口。
- 不展示副本来源。
- 不在前端重建或修正故事上下文。
- 不在复制成功后自动发起上下文提取。
- 不新增前端持久化草稿。
- 不新增服务端幂等 request ID。

## 现有前端约束

- 前端使用 React、React Router 和 TypeScript。
- 样式使用 Tailwind CSS v4 和现有 CSS 变量。
- Toast 使用 `sonner`。
- 共享请求响应契约来自 `@kimiko/schema`。
- 故事 HTTP client 集中在 `packages/web/src/story/storylineApi.ts`。
- 故事详情主体集中在 `packages/web/src/pages/story/StoryPage.tsx`。
- `StoryPageHeader` 当前位于 `StoryPage.tsx` 内部，只显示固定标题、「调试」和「返回列表」。
- `StoryActionFab` 只在最后一章展示，且专用于续写、重写和互动，不适合作为任意章节复制入口。
- `StorylineSnapshot` 当前不包含标题，详情页无法直接取得源故事展示标题。
- `StorylineListItem` 已包含服务端派生的 `title`。
- Web 包当前没有单元测试脚本，验证以类型检查、构建、服务端契约测试和人工交互检查为主。

## 共享契约调整

### 标题

新增统一标题 schema，并让列表项和快照复用：

```ts
export const StorylineTitleSchema = z.string().trim().min(1).max(80);

export type StorylineTitle = z.infer<typeof StorylineTitleSchema>;
```

`StorylineListItemSchema.title` 改为 `StorylineTitleSchema`，行为不变。

`StorylineSnapshotSchema` 增加：

```ts
title: StorylineTitleSchema,
```

由于 `CompletedStorylineSnapshotSchema` 基于 `StorylineSnapshotSchema` 扩展，实时生成完成事件会自然携带标题。

### 复制请求

```ts
export const CopyStorylineRequestSchema = z
  .object({
    title: StorylineTitleSchema,
    throughChapter: z.number().int().positive(),
  })
  .strict();

export type CopyStorylineRequest = z.infer<typeof CopyStorylineRequestSchema>;
```

`throughChapter` 的动态上限由服务端根据源故事实际章节数校验，前端同时使用当前 `chapterCount` 做即时校验。

### 复制响应

```ts
export const CopyStorylineResponseSchema = z
  .object({
    storyline: StorylineSnapshotSchema,
  })
  .strict();

export type CopyStorylineResponse = z.infer<typeof CopyStorylineResponseSchema>;
```

响应中的快照以新故事最后一章为锚点，只返回现有章节窗口大小允许的内容，不要求返回第 1 章到第 N 章的全部正文。

## API Client

在 `packages/web/src/story/storylineApi.ts` 增加：

```ts
export type CopyStorylineResult =
  | Readonly<{ status: "success"; storyline: StorylineSnapshot }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "busy"; message: string }>
  | Readonly<{ status: "invalid"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function copyStoryline(
  storylineId: StorylineId,
  input: CopyStorylineRequest,
): Promise<CopyStorylineResult>;
```

请求：

```http
POST /storylines/:storylineId/copies
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "原标题（副本）",
  "throughChapter": 6
}
```

状态映射：

| HTTP 状态      | 前端状态       | 行为                         |
| -------------- | -------------- | ---------------------------- |
| `201`          | `success`      | 解析响应并跳转新故事         |
| `400`          | `invalid`      | 保持弹窗，展示服务端参数错误 |
| `401`          | `authRequired` | 清理会话并跳转登录页         |
| `404`          | `notFound`     | 进入现有故事不存在状态       |
| `409`          | `busy`         | 保持弹窗，提示故事正在处理中 |
| 其他或网络错误 | `failed`       | 保持弹窗，展示通用错误       |

默认错误文案：

```text
复制故事失败，请稍后重试
```

冲突文案：

```text
当前故事正在处理中，请稍后重试
```

## 页面结构

### 故事详情页顶部

调整 `StoryPageHeader`：

```ts
interface StoryPageHeaderProps {
  isGenerating: boolean;
  onBackToList: () => void;
  onCopyStoryline: () => void;
  onOpenContext: () => void;
  title: string;
}
```

顶部结构：

- 左侧：StoryAgent 标识和当前故事标题。
- 右侧：「更多」按钮和「返回列表」按钮。
- 更多菜单：「复制故事」「上下文」。

新建故事且尚未保存时：

- 没有正式 `StorylineSnapshot`。
- 不展示「更多」按钮。
- 标题继续使用现有创建态文案。

已保存故事：

- 使用 `storyline.title` 展示标题。
- 标题过长时保持单行截断。
- 菜单通过按钮触发，不使用嵌套链接。

### 更多菜单

建议从 `StoryPage.tsx` 拆出：

```text
packages/web/src/pages/story/StoryPageHeader.tsx
```

菜单行为：

- 点击「更多」切换展开状态。
- 点击页面其他区域关闭。
- 按 `Escape` 关闭。
- 选择菜单项后先关闭菜单，再执行对应操作。
- 「上下文」复用现有 `handleOpenContextDebug` 的导航和未提交草稿确认逻辑。
- 对用户可见的文案统一改为「上下文」，内部函数和路由名称本期可以暂不重命名。
- `isGenerating=true` 时「复制故事」禁用并提供可访问的禁用说明。

## 复制弹窗

新增组件：

```text
packages/web/src/pages/story/StorylineCopyDialog.tsx
```

建议接口：

```ts
interface StorylineCopyDialogSubmitValue {
  readonly title: string;
  readonly throughChapter: number;
}

interface StorylineCopyDialogProps {
  readonly chapterCount: number;
  readonly defaultThroughChapter: number;
  readonly error?: string;
  readonly isSubmitting: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (value: StorylineCopyDialogSubmitValue) => void;
  readonly sourceTitle: string;
}
```

组件内部维护标题、章节字符串和字段错误，使请求失败后表单值不会因父组件状态刷新而丢失。

每次组件重新挂载时初始化：

```ts
title = buildDefaultCopyTitle(sourceTitle);
throughChapter = String(defaultThroughChapter);
```

关闭后重新打开会创建新的组件实例，并按当前阅读章节重新生成默认值。

### 默认标题

```ts
const copyTitleSuffix = "（副本）";
const storylineTitleMaxLength = 80;

function buildDefaultCopyTitle(sourceTitle: string): string {
  const availableSourceLength =
    storylineTitleMaxLength - copyTitleSuffix.length;
  return `${sourceTitle.trim().slice(0, availableSourceLength)}${copyTitleSuffix}`;
}
```

实际实现应按 JavaScript 字符串长度与共享 schema 保持一致。后缀必须完整保留。

### 表单校验

标题：

- `trim()` 后不能为空。
- 最长 80 个字符。
- 错误文案分别为「请输入新故事标题」和「标题不能超过 80 个字符」。

截止章节：

- 使用 `input type="number"`。
- `min=1`。
- `max=chapterCount`。
- `step=1`。
- 必须是安全整数。
- 错误文案为「请输入 1 到 X 之间的整数章节」。

前端校验成功后才调用 API：

```ts
{
  title: normalizedTitle,
  throughChapter,
}
```

### 可访问性

- 使用 `role="dialog"` 和 `aria-modal="true"`。
- 标题与 `aria-labelledby` 关联。
- 字段错误通过 `aria-describedby` 和 `aria-invalid` 关联。
- 打开后聚焦标题输入框。
- `Escape` 在非提交状态下关闭弹窗。
- 提交状态下阻止关闭，避免用户误认为请求已取消。
- 遮罩点击在非提交状态下关闭。

## StoryPage 状态

新增最小父级状态：

```ts
const [isCopyDialogOpen, setIsCopyDialogOpen] = useState(false);
const [copyStatus, setCopyStatus] = useState<"idle" | "submitting">("idle");
const [copyError, setCopyError] = useState<string | undefined>();
```

打开弹窗前计算：

```ts
const currentChapter =
  readerPageIndex === null
    ? storyline.chapterCount
    : Math.min(readerPageIndex + 1, storyline.chapterCount);
```

打开条件：

- `storyline !== null`。
- 当前没有正文生成任务。
- 当前章节已加载。

已知正在生成时不打开弹窗。若打开弹窗后故事状态变为生成中，提交前再次检查并展示忙碌提示。

## 提交流程

```text
用户提交
  -> 前端字段校验
  -> copyStatus = submitting
  -> POST /storylines/:id/copies
  -> 根据结果分支
```

成功：

1. 记录本次 `throughChapter`。
2. 关闭弹窗。
3. 使用 React Router `navigate` 推入新故事 URL：

```text
/storylines/<newStorylineId>
```

新故事的最后一章就是 N，因此不需要附加 `?page=N`。

4. 调用：

```ts
toast.success(`已复制前 ${throughChapter} 章`);
```

5. 新路由按现有恢复流程加载故事。浏览器后退可以返回原故事。

失败：

- `busy`、`invalid`、`failed`：恢复 `idle`，设置弹窗级错误，保留组件内部输入。
- `authRequired`：关闭本地连接并跳转 `/login`。
- `notFound`：关闭弹窗，清空故事状态，复用现有 `restoreFailed` 页面。

## 标题在现有流程中的兼容

`StorylineSnapshot` 增加必填 `title` 后，需要同步更新：

- 服务端所有故事快照。
- WebSocket 完成事件测试 fixture。
- `buildSubmittedCreateStoryline` 创建中的临时快照。
- StoryPage 内部所有手写快照。
- 服务端 E2E 预期。
- 章节缓存合并函数返回的快照。

创建中的临时标题可以继续从 `initialStoryText` 第一行派生，仅用于满足本地预览类型和详情顶部展示。正式保存后以服务端返回标题为准。

普通故事不提供标题输入。服务端对普通故事和旧数据返回从初始正文派生的标题，前端不区分标题来源。

## 与现有生成状态的关系

- 复制不修改 `isGenerating` 的定义。
- 复制使用独立 `copyStatus`，不触发正文推理面板、临时章节或生成状态文案。
- 提交复制时不关闭现有 WebSocket；正常情况下复制入口在生成期间不可用。
- 服务端仍是并发判断的最终权威。
- 收到 `409` 后不自动轮询或自动重试。

## 错误与边界

### N=1

- 可以提交。
- 成功后打开只有初始章节的新故事。
- 现有 `latestGeneration === null` 逻辑会隐藏重写并保留续写、互动。

### N=chapterCount

- 复制全部正式章节。
- 新故事默认打开最后一章。

### 当前章节变化

- 弹窗打开后，翻页操作被遮罩阻止。
- 弹窗中的默认 N 不随后台 reader state 变化。
- 关闭并重新打开后使用新的当前章节。

### 章节总数变化

复制期间源故事被服务端故事锁保护。若客户端章节数已过期，服务端重新校验：

- N 仍有效：允许复制。
- N 无效：返回 `400`，弹窗保持打开。

### 网络超时

- 恢复表单可操作状态。
- 展示通用失败信息。
- 用户可以重试。
- 由于本期没有严格幂等，重试可能创建第二个副本；前端不尝试通过标题或正文猜测去重。

## 文件改动建议

```text
packages/schema/src/index.ts
  - 新增 StorylineTitleSchema
  - StorylineSnapshotSchema 增加 title
  - 新增 CopyStorylineRequest/Response schema

packages/web/src/story/storylineApi.ts
  - 新增 copyStoryline
  - 新增 CopyStorylineResult

packages/web/src/pages/story/StoryPage.tsx
  - 接入复制弹窗状态和提交处理
  - 使用 storyline.title
  - 将上下文入口传给新 Header

packages/web/src/pages/story/StoryPageHeader.tsx
  - 展示标题
  - 实现更多菜单

packages/web/src/pages/story/StorylineCopyDialog.tsx
  - 标题和截止章节表单
  - 校验、加载和错误状态
```

## 验证

### 静态验证

- `pnpm --filter @kimiko/schema typecheck`
- `pnpm --filter @kimiko/web typecheck`
- `pnpm --filter @kimiko/web build`
- `pnpm --filter @kimiko/web lint`

### 人工交互

- 在第 1 章、第中间章和最后一章打开弹窗，确认默认 N。
- 修改标题和 N 后模拟失败，确认输入保留。
- 生成中确认复制项禁用。
- 模拟 `409`，确认弹窗保留并展示忙碌文案。
- 复制成功后确认跳转新故事最后一章并出现 Toast。
- 浏览器后退确认返回原故事。
- 确认顶部菜单的「上下文」仍进入原调试页面。
- 检查键盘焦点、Escape、遮罩关闭和字段错误关联。

## 验收映射

| PRD 要求         | 前端实现                                 |
| ---------------- | ---------------------------------------- |
| 任意章节发起复制 | 常驻顶部更多菜单                         |
| N 默认当前章节   | 读取 `readerPageIndex + 1`               |
| N 可修改         | 数字输入框，范围 `1..chapterCount`       |
| 独立标题         | 弹窗标题输入 + `StorylineSnapshot.title` |
| 失败保留输入     | 表单状态保留在未卸载的 Dialog 内         |
| 禁止重复点击     | `copyStatus=submitting` 时禁用表单       |
| 源故事繁忙       | 本地禁用 + 服务端 `409`                  |
| 成功进入副本     | 导航 `/storylines/:newId`                |
| 成功反馈         | `sonner` Toast                           |
| 上下文入口改名   | 更多菜单中的「上下文」                   |
