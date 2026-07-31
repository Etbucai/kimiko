# 从设定开始创建故事前端技术方案

## 背景

本文档对应 PRD：[setting-start-prd.md](./setting-start-prd.md)。

012 的产品目标是：在现有创建故事流程中新增「从设定开始」模式。用户可以先创建并保存一份纯文本设定，也可以从已有设定进入新故事创建流程。前端需要在不影响现有「正文 + 续写指令」默认创建方式的前提下，新增设定列表、创建设定、设定详情和从设定创建故事四个子流程。

当前前端故事创建入口集中在：

- `/storylines/new` 路由。
- `StoryPage mode="new"`。
- `StoryInitialInput` + `StorylineComposer`。
- `startStoryRealtimeGeneration` 的 `mode: "create"` payload。
- `StorylineReader` 用本地 preview snapshot 展示创建中的第一页和流式第二页。

因此本期前端方案以复用 `/storylines/new` 和现有实时生成链路为主，同时新增设定管理 API client 与若干局部 UI 组件。

## 已确认决策

- 新增独立前端技术文档：`docs/012/setting-start-prd-fe.md`。
- `/storylines/new` 默认仍展示现有「正文 + 续写指令」创建表单。
- 在 `/storylines/new` 顶部区域新增「从设定开始」入口。
- 设定列表页、创建设定页、设定详情页都作为 `/storylines/new` 内部 view state，不新增独立路由。
- 从设定创建故事页复用 `/storylines/new`，使用查询参数：

```text
/storylines/new?mode=setting&settingId=<settingId>
```

- 用户直接打开上述 URL 时，前端需要拉取设定详情并恢复从设定创建故事页。
- 设定补全使用独立流式接口，不复用故事 `story.continue` WebSocket。
- 设定保存使用普通 HTTP 接口。
- 从设定创建故事继续复用 `startStoryRealtimeGeneration`，但新增一个独立 payload 分支。
- 创建中的临时横向 Reader 继续复用 `StorylineReader`。
- 设定列表、设定详情、从设定创建故事页都只展示当前用户自己的设定。
- 灵感草稿和开场草稿只保存在 React state 中，离开对应 view 时清空。
- 不使用 `localStorage`、`sessionStorage` 或服务端草稿保存灵感与开场。
- 失败提示统一使用 `sonner` toast。

## 非目标

- 不新增设定编辑 UI。
- 不新增设定删除 UI。
- 不新增设定搜索、筛选、分类、模板或收藏。
- 不新增设定分享能力。
- 不新增复杂富文本展示；设定内容按纯文本换行展示。
- 不把设定草稿、开场草稿持久化。
- 不改变已有故事详情页的续写、重写、互动流程。
- 不为 create 任务新增退出后找回能力。

## 现有前端约束

- 前端使用 React + React Router。
- 样式使用 Tailwind CSS v4 和当前 CSS 变量。
- Toast 使用 `sonner`。
- 共享契约来自 `@kimiko/schema`。
- HTTP API client 当前集中在 `packages/web/src/story/storylineApi.ts`，本期建议新增独立 `storySettingApi.ts`。
- 通用 LLM NDJSON 流式客户端位于 `packages/web/src/llm/llmApi.ts`，本期可复用其事件 schema 与解析模式。
- 故事实时生成客户端位于 `packages/web/src/story/storyRealtimeApi.ts`。
- `StoryPage` 当前已经承担创建、详情、后台任务恢复、抽屉和 Reader 临时态，需要避免继续堆积大块 JSX。
- TypeScript 必须保持严格类型安全：
  - 类型导入使用 `import type`。
  - 非原始值 `useState`、`useRef` 必须显式标注泛型。

## IDL Schema

本节描述前端需要消费的共享契约。后端技术方案如需调整字段或接口语义，应单独说明差异。

### 设定基础模型

```ts
export const StorySettingIdSchema = z.string().trim().min(1);

export type StorySettingId = z.infer<typeof StorySettingIdSchema>;

export const StorySettingContentSchema = z.string().trim().min(1).max(20_000);

export type StorySettingContent = z.infer<typeof StorySettingContentSchema>;

export const StorySettingSchema = z
  .object({
    id: StorySettingIdSchema,
    content: StorySettingContentSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export type StorySetting = z.infer<typeof StorySettingSchema>;

export const StorySettingListItemSchema = z
  .object({
    id: StorySettingIdSchema,
    preview: z.string().trim().min(1).max(240),
    createdAt: z.string().datetime(),
  })
  .strict();

export type StorySettingListItem = z.infer<typeof StorySettingListItemSchema>;
```

说明：

- `content` 是完整设定文本。
- `preview` 用于列表卡片展示，由服务端从 `content` 派生。
- 本期不引入 `title` 字段，避免前端展示一个需要用户理解但无法编辑的隐式标题。
- `createdAt` 用于列表倒序展示和卡片辅助信息。

### 设定列表与详情

```ts
export const ListStorySettingsResponseSchema = z
  .object({
    settings: z.array(StorySettingListItemSchema).max(100),
  })
  .strict();

export type ListStorySettingsResponse = z.infer<
  typeof ListStorySettingsResponseSchema
>;

export const GetStorySettingResponseSchema = z
  .object({
    setting: StorySettingSchema,
  })
  .strict();

export type GetStorySettingResponse = z.infer<
  typeof GetStorySettingResponseSchema
>;
```

### 设定补全

```ts
export const CompleteStorySettingRequestSchema = z
  .object({
    inspiration: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type CompleteStorySettingRequest = z.infer<
  typeof CompleteStorySettingRequestSchema
>;
```

设定补全接口返回 NDJSON，事件格式复用现有通用 LLM 流式事件：

```ts
export const StorySettingCompletionStreamEventSchema =
  GenerateLlmTextStreamEventSchema;

export type StorySettingCompletionStreamEvent = GenerateLlmTextStreamEvent;
```

说明：

- 补全过程不保存设定。
- 前端只把用户输入的灵感传给后端。
- 设定补全 prompt 由服务端封装，前端不拼接系统 prompt。
- `completed` 事件中的 model、usage、finishReason 本期不在 UI 展示。

### 保存设定

```ts
export const CreateStorySettingRequestSchema = z
  .object({
    content: StorySettingContentSchema,
  })
  .strict();

export type CreateStorySettingRequest = z.infer<
  typeof CreateStorySettingRequestSchema
>;

export const CreateStorySettingResponseSchema = z
  .object({
    setting: StorySettingSchema,
  })
  .strict();

export type CreateStorySettingResponse = z.infer<
  typeof CreateStorySettingResponseSchema
>;
```

### 从设定创建故事

新增故事创建 payload 分支：

```ts
export const StoryContinueCreateFromSettingPayloadSchema = z
  .object({
    mode: z.literal("createFromSetting"),
    settingId: StorySettingIdSchema,
    opening: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type StoryContinueCreateFromSettingPayload = z.infer<
  typeof StoryContinueCreateFromSettingPayloadSchema
>;
```

`StoryContinuePayloadSchema` 增加该分支：

```ts
export const StoryContinuePayloadSchema = z.discriminatedUnion("mode", [
  StoryContinueCreatePayloadSchema,
  StoryContinueCreateFromSettingPayloadSchema,
  StoryContinueAppendPayloadSchema,
  StoryContinueRewritePayloadSchema,
  StoryContinueDialoguePayloadSchema,
]);
```

生成任务模式增加：

```ts
export const StoryGenerationModeSchema = z.enum([
  "create",
  "createFromSetting",
  "append",
  "rewrite",
  "dialogue",
]);
```

错误码建议增加：

```ts
export const StoryRealtimeErrorCodeSchema = z.enum([
  // existing codes...
  "STORY_SETTING_NOT_FOUND",
  "STORY_SETTING_ACCESS_DENIED",
]);
```

说明：

- 前端提交 `settingId + opening`，不提交 `setting.content`，避免客户端内容与服务端保存内容不一致。
- 服务端负责校验设定归属并读取设定内容参与生成。
- 前端仍使用本地已加载的 `setting.content` 构造临时第一页展示。

## HTTP 与流式 API

建议新增 `packages/web/src/story/storySettingApi.ts`。

### `listStorySettings`

```ts
export type ListStorySettingsResult =
  | Readonly<{ status: "success"; settings: readonly StorySettingListItem[] }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function listStorySettings(): Promise<ListStorySettingsResult>;
```

请求：

```http
GET /story-settings
```

处理规则：

- `401`：清理登录态并返回 `authRequired`。
- 非 `2xx`：返回 `failed`。
- schema 校验失败：返回 `failed`。
- 成功：返回倒序列表。前端不再二次排序，只信任服务端排序。

### `getStorySetting`

```ts
export type GetStorySettingResult =
  | Readonly<{ status: "success"; setting: StorySetting }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export async function getStorySetting(
  settingId: StorySettingId,
): Promise<GetStorySettingResult>;
```

请求：

```http
GET /story-settings/:settingId
```

处理规则：

- `401`：清理登录态并返回 `authRequired`。
- `404`：返回 `notFound`。
- 非 `2xx`：返回 `failed`。
- schema 校验失败：返回 `failed`。

### `startStorySettingCompletionStream`

```ts
export interface StorySettingCompletionCallbacks {
  onStarted: () => void;
  onChunk: (delta: string, sequence: number) => void;
  onCompleted: () => void;
  onCancelled: () => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

export interface StorySettingCompletionHandle {
  cancel: () => void;
  close: () => void;
}

export function startStorySettingCompletionStream(
  request: CompleteStorySettingRequest,
  callbacks: StorySettingCompletionCallbacks,
): StorySettingCompletionHandle;
```

请求：

```http
POST /story-settings/complete/stream
Accept: application/x-ndjson
Content-Type: application/json
```

行为：

- 流式协议与 `startLlmTextStream` 一致。
- 用户离开创建设定 view 时调用 `close()`，静默停止本次前端展示。
- 用户主动取消能力本期不在 UI 展示，但 handle 仍保留 `cancel()`，方便组件卸载和未来扩展。

### `createStorySetting`

```ts
export type CreateStorySettingResult =
  | Readonly<{ status: "success"; setting: StorySetting }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "failed"; message: string }>;

export async function createStorySetting(
  request: CreateStorySettingRequest,
): Promise<CreateStorySettingResult>;
```

请求：

```http
POST /story-settings
Content-Type: application/json
```

处理规则：

- `401`：清理登录态并返回 `authRequired`。
- 非 `2xx`：返回 `failed`。
- schema 校验失败：返回 `failed`。
- 成功：返回保存后的完整设定。

## 页面状态设计

### `StoryPage` 新增新建子模式

建议新增内部 view state：

```ts
type NewStoryView =
  | Readonly<{ type: "manual" }>
  | Readonly<{ type: "settingList" }>
  | Readonly<{ type: "settingCreate" }>
  | Readonly<{ type: "settingDetail"; settingId: StorySettingId }>
  | Readonly<{ type: "createFromSetting"; settingId: StorySettingId }>;
```

初始化规则：

- `mode !== "new"` 时不启用该状态，故事详情页行为不变。
- `/storylines/new` 无查询参数时，初始化为 `{ type: "manual" }`。
- `/storylines/new?mode=setting&settingId=...` 时，初始化为 `{ type: "createFromSetting", settingId }`。
- 查询参数缺失或不合法时，回退到 `{ type: "manual" }`。

跳转规则：

- 手动创建页点击「从设定开始」：`setNewStoryView({ type: "settingList" })`。
- 设定列表返回：`setNewStoryView({ type: "manual" })`。
- 设定列表点击「新设定」：`setNewStoryView({ type: "settingCreate" })`。
- 创建设定返回：清空灵感和补全输出，回到 `{ type: "settingList" }`。
- 设定列表点击设定项：`setNewStoryView({ type: "settingDetail", settingId })`。
- 设定详情返回：回到 `{ type: "settingList" }`。
- 设定详情点击「从设定开始」：导航到 `/storylines/new?mode=setting&settingId=...`。
- 创建设定保存成功：导航到 `/storylines/new?mode=setting&settingId=<newId>`。
- 从设定创建故事页返回：导航到 `/storylines`。

### 草稿清理

以下状态只在对应 view 存活：

```ts
const [settingInspiration, setSettingInspiration] = useState("");
const [settingCompletionText, setSettingCompletionText] = useState("");
const [settingOpening, setSettingOpening] = useState("");
```

清理规则：

- 离开 `settingCreate` 时，调用补全 stream handle 的 `close()`，清空 `settingInspiration` 和 `settingCompletionText`。
- 离开 `createFromSetting` 且未进入生成中 Reader 时，清空 `settingOpening`。
- 保存失败时，清空 `settingCompletionText`，保留 `settingInspiration` 并恢复可编辑。
- 补全失败时，清空 `settingCompletionText`，保留 `settingInspiration` 并恢复可编辑。

### 状态拆分

避免继续扩大 `StorylinePageStatus`。设定子流程建议使用独立状态：

```ts
type StorySettingListStatus = "loading" | "ready" | "empty" | "failed";

type StorySettingDetailStatus = "loading" | "ready" | "failed";

type StorySettingCompletionStatus =
  "idle" | "streaming" | "completed" | "saving" | "failed";
```

`StorylinePageStatus` 仍只表示故事线恢复和故事生成状态。

## 组件设计

建议新增组件：

- `StorySettingEntryButton.tsx`
  - 放在手动创建页顶部或 `StoryInitialInput` 上方。
  - 点击进入设定列表 view。
- `StorySettingListView.tsx`
  - 展示返回按钮、新设定按钮、列表、loading、empty、failed。
  - 接收 `settings`、`status`、`onRetry`、`onBack`、`onCreate`、`onSelect`。
- `StorySettingCreateView.tsx`
  - 展示灵感输入、补全按钮、流式输出、保存按钮。
  - 不直接调用 API，只通过 props 回调。
- `StorySettingDetailView.tsx`
  - 拉取完成后展示完整设定文本和「从设定开始」按钮。
- `StoryCreateFromSettingView.tsx`
  - 展示设定文本、开场输入框和「开场」按钮。
  - 不负责流式 Reader，提交后由 `StoryPage` 切到现有本地 preview Reader。
- `StorySettingTextBlock.tsx`
  - 统一设定纯文本展示样式，使用 `whitespace-pre-wrap`。

保留在 `StoryPage` 内的职责：

- 根据 `NewStoryView` 决定渲染哪个子 view。
- 统一处理 authRequired 后跳转登录页。
- 持有 `startStoryRealtimeGeneration` handle。
- 构造 create-from-setting payload 和临时 preview snapshot。
- 生成完成后导航到正式故事详情页。

## 手动创建页入口

在现有手动创建页中，将结构调整为：

```text
StorySettingEntryButton
StoryInitialInput
Divider
StorylineComposer
```

入口按钮建议样式：

- 使用圆角卡片或次级按钮。
- 文案为「从设定开始」。
- 放在顶部栏下方、正文输入框上方。
- 不改变当前默认焦点和输入行为。

## 设定列表页

加载时机：

- 首次进入 `settingList` view 时调用 `listStorySettings()`。
- 从创建设定页返回列表时重新加载，确保新保存内容可见。
- 从详情页返回列表时可复用已有列表，不强制刷新。

列表卡片：

- 主体展示 `preview`。
- 辅助展示 `createdAt` 的本地格式化时间。
- 点击整张卡片进入详情。

空状态：

- 标题：`还没有设定`
- 描述：`先创建一份设定，再从它开始新故事。`
- 主按钮：`新设定`

失败状态：

- 展示错误文案和「重试」按钮。
- 不自动 toast，避免进入页面时 toast 与错误卡片重复。

## 创建设定页

### 补全流程

提交前校验：

- `settingInspiration.trim().length === 0` 时，展示字段错误：`请输入灵感`。
- 只在前端做非空校验，长度上限由 textarea `maxLength=8000` 和共享 schema 双重约束。

开始补全：

1. 清空旧错误和旧 `settingCompletionText`。
2. 设置 `completionStatus = "streaming"`。
3. 调用 `startStorySettingCompletionStream({ inspiration })`。
4. 输入框 disabled。
5. 「补全设定」按钮 loading 且 disabled。
6. `onChunk` 追加到 `settingCompletionText`。

补全完成：

- 设置 `completionStatus = "completed"`。
- 输入框保持 disabled。
- 展示「保存设定」按钮。

补全失败：

- toast：`补全设定失败，请稍后重试` 或使用接口 message。
- 清空 `settingCompletionText`。
- 设置 `completionStatus = "failed"` 后回到可编辑状态。

### 保存流程

保存按钮只在 `completionStatus === "completed"` 且 `settingCompletionText.trim().length > 0` 时展示。

点击保存：

1. 设置 `completionStatus = "saving"`。
2. 调用 `createStorySetting({ content: settingCompletionText })`。
3. 保存按钮 disabled。

保存成功：

- 清空灵感和补全输出。
- 导航到 `/storylines/new?mode=setting&settingId=<newId>`。

保存失败：

- toast：`保存设定失败，请稍后重试` 或使用接口 message。
- 清空 `settingCompletionText`。
- 输入框恢复可编辑。
- 设置 `completionStatus = "idle"`。

## 设定详情页

加载规则：

- 进入 `settingDetail` 时调用 `getStorySetting(settingId)`。
- `authRequired` 跳转登录页。
- `notFound` 或 `failed` 展示错误卡片，提供返回列表按钮。

展示规则：

- 完整设定文本使用 `StorySettingTextBlock`。
- 设定详情页不展示编辑、删除、复制按钮。
- 主按钮「从设定开始」导航到 `/storylines/new?mode=setting&settingId=...`。

## 从设定创建故事页

### 进入与加载

进入 `/storylines/new?mode=setting&settingId=...` 后：

1. `StoryPage` 解析查询参数。
2. 调用 `getStorySetting(settingId)`。
3. loading 期间展示设定加载状态。
4. 成功后渲染 `StoryCreateFromSettingView`。
5. 失败时展示错误卡片，提供「返回故事列表」和「重试」。

### 页面内容

`StoryCreateFromSettingView` 展示：

- 返回按钮：返回 `/storylines`。
- 设定内容：只读纯文本。
- 开场输入框：`maxLength=8000`。
- 主按钮：`开场`。

提交前校验：

- `settingOpening.trim().length === 0` 时，字段错误：`请输入开场`。

### Payload

提交时构造：

```ts
const payload: StoryContinueCreateFromSettingPayload = {
  mode: "createFromSetting",
  settingId: setting.id,
  opening,
};
```

同时构造本地 preview：

```ts
interface SubmittedCreateFromSettingDraft {
  readonly settingId: StorySettingId;
  readonly settingContent: string;
  readonly opening: string;
}
```

临时第一页文本建议由 helper 统一生成：

```ts
function buildCreateFromSettingInitialText(
  draft: SubmittedCreateFromSettingDraft,
): string {
  return ["【设定】", draft.settingContent, "", "【开场】", draft.opening].join(
    "\n",
  );
}
```

这样可以在生成中和生成完成后的第一页保持一致。

### 生成中展示

提交后：

- `StoryPage` 隐藏 `StoryCreateFromSettingView`。
- 使用 `StorylineReader` 展示临时 preview snapshot。
- 第一页为 `buildCreateFromSettingInitialText(draft)`。
- 第二页为 `temporaryAppendText` 流式正文。
- `activeGenerationIntent` 新增 `{ type: "createFromSetting" }`。
- `onContextStarted` 后沿用现有“正在更新故事上下文...”状态。

`GenerationIntent` 扩展：

```ts
type GenerationIntent =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "createFromSetting" }>
  | Readonly<{ type: "append" }>
  | Readonly<{ type: "rewrite"; segmentId: StorylineSegmentId }>
  | Readonly<{ type: "dialogue" }>;
```

### 成功、失败、取消

成功：

- 清空 `settingOpening`、`submittedCreateFromSettingDraft` 和临时正文。
- 导航到 `/storylines/:storylineId`。

失败：

- toast 提示错误。
- 清空 `temporaryAppendText`。
- 清空 `submittedCreateFromSettingDraft`。
- 保留 `settingOpening`。
- 回到 `StoryCreateFromSettingView`。

取消：

- 当前 PRD 未提供显式取消入口。
- 如果用户在生成中点击返回故事列表，行为与现有 create 一致：关闭当前实时连接并离开页面；服务端 create 任务是否继续由后端任务生命周期决定。

## `StoryPage` 关键调整

### URL 查询参数

`StoryPage` 当前只依赖路由 props，需要新增读取 search params：

```ts
import { useSearchParams } from "react-router";
```

解析规则：

```ts
function parseNewStoryViewFromSearchParams(
  searchParams: URLSearchParams,
): NewStoryView {
  if (searchParams.get("mode") !== "setting") {
    return { type: "manual" };
  }

  const settingId = searchParams.get("settingId")?.trim();
  if (settingId === undefined || settingId.length === 0) {
    return { type: "manual" };
  }

  return { type: "createFromSetting", settingId };
}
```

注意：

- 内部列表、创建、详情 view 不写入 URL。
- 只有 create-from-setting 写入 URL。
- 从 query 回到 manual 时应使用 `navigate("/storylines/new", { replace: true })` 清理 search。

### `validatePayload`

建议不要把 create-from-setting 塞进现有 `validatePayload` 的 `storyline === null` 分支里。该分支目前服务于手动创建表单。

新增独立方法：

```ts
function validateCreateFromSettingPayload(input: {
  opening: string;
  setting: StorySetting | null;
}): CreateFromSettingValidationResult;
```

原因：

- 手动 create 校验字段是 `initialStoryText + appendInstruction`。
- 从设定 create 校验字段是 `setting + opening`。
- 两者 UI 和错误归属不同，拆开能减少条件分支。

### 本地 preview snapshot

现有 `buildSubmittedCreateStoryline` 可以抽象为：

```ts
function buildSubmittedCreatePreviewStoryline(input: {
  initialText: string;
}): StorylineSnapshot;
```

手动 create 传入 `initialStoryText`。

从设定 create 传入 `buildCreateFromSettingInitialText(draft)`。

## 鉴权与错误处理

所有新增 API client 遵循现有 `storylineApi.ts` 习惯：

- 无登录态：返回 `authRequired`。
- `401`：`clearAuthSession()` 后返回 `authRequired`。
- `authRequired`：页面跳转 `/login`。
- schema 校验失败：返回 `failed`，不把 Zod 细节暴露给用户。

默认错误文案：

```ts
const defaultSettingListErrorMessage = "加载设定列表失败，请稍后重试";
const defaultSettingDetailErrorMessage = "加载设定失败，请稍后重试";
const defaultSettingCompletionErrorMessage = "补全设定失败，请稍后重试";
const defaultSettingSaveErrorMessage = "保存设定失败，请稍后重试";
const defaultCreateFromSettingErrorMessage = "开场生成失败，请稍后重试";
```

## 可访问性与交互细节

- 所有返回按钮、主按钮、列表卡片使用真实 `button` 或 `Link`。
- 多行输入框需要正确绑定 `aria-invalid` 和错误提示 `aria-describedby`。
- loading 状态区域使用 `role="status"`。
- 错误区域使用 `role="alert"`。
- 设定列表卡片点击区域应覆盖整张卡片。
- 纯文本设定展示使用 `whitespace-pre-wrap`，保留用户换行。
- 生成中、补全中、保存中按钮必须 disabled，避免重复提交。

## 文件调整清单

新增：

- `packages/web/src/story/storySettingApi.ts`
- `packages/web/src/pages/story/StorySettingEntryButton.tsx`
- `packages/web/src/pages/story/StorySettingListView.tsx`
- `packages/web/src/pages/story/StorySettingCreateView.tsx`
- `packages/web/src/pages/story/StorySettingDetailView.tsx`
- `packages/web/src/pages/story/StoryCreateFromSettingView.tsx`
- `packages/web/src/pages/story/StorySettingTextBlock.tsx`

调整：

- `packages/schema/src/index.ts`
  - 新增设定模型、设定 API schema、create-from-setting payload。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 新增 `NewStoryView`。
  - 新增设定子流程状态和 handler。
  - 新增 query 参数解析。
  - 扩展 `GenerationIntent`。
  - 新增 create-from-setting 临时 preview。
- `packages/web/src/story/storyRealtimeApi.ts`
  - 类型自动跟随 `StoryContinuePayload` 扩展，无需新增 runtime 分支。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - 原则上不需要修改。
  - 如需优化第一页标签，可仅增加可选展示文案，不改变分页模型。

不需要调整：

- `StoryActionDrawer`
- `StoryActionFab`
- `StorylineListPage`
- `StoryContextDebugPage`
- `append-target-length-preference.ts`

## 验证计划

前端验证命令：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```

建议手动验证：

- `/storylines/new` 默认仍展示手动创建表单。
- 点击「从设定开始」进入设定列表。
- 空列表展示空状态。
- 点击「新设定」进入创建设定页。
- 灵感为空时不能补全。
- 补全中输入框不可编辑，按钮不可重复点击，输出流式追加。
- 补全失败时 toast，输出清空，输入框恢复可编辑。
- 补全成功后展示保存按钮。
- 保存失败时 toast，输出清空，输入框恢复可编辑。
- 保存成功后进入 `/storylines/new?mode=setting&settingId=...`。
- 刷新上述 URL 后仍能恢复从设定创建故事页。
- 开场为空时不能提交。
- 点击「开场」后第一页展示设定和开场，第二页流式展示生成正文。
- 生成失败时删除临时第二页，回到开场输入页，开场内容保留。
- 生成成功后跳转到新故事详情页。
- 设定详情页不展示编辑和删除入口。
- 离开创建设定页后，灵感和补全输出不会恢复。
- 离开从设定创建故事页后，开场草稿不会恢复。

## 风险与取舍

### `StoryPage` 继续变大

`StoryPage` 已经承担较多状态。本期需要把设定列表、创建、详情、从设定创建拆成子组件，只把编排状态留在 `StoryPage`，避免把大段 JSX 继续写进主文件。

### create payload 新增模式会影响服务端分发

新增 `mode: "createFromSetting"` 能保持共享契约的 discriminated union 简单清晰，但服务端需要新增分支。前端不建议把设定内容拼进旧 `mode: "create"` payload，否则会让服务端难以区分普通创建和设定创建，也不利于后续统计和调试。

### 补全流式接口与通用 LLM 流式接口相似

设定补全可以复用现有 NDJSON 事件格式，但不建议直接让前端调用通用 `/llm/generate/stream` 并拼 prompt。产品功能 prompt 应由服务端封装，前端只提交用户灵感。

### 只用 React state 保存草稿

灵感和开场草稿离开页面即丢失，符合 PRD 的轻量策略，但误触返回会造成输入丢失。本期不加确认弹窗，前端只保证清理行为稳定一致。
