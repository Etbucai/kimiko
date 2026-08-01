# 故事上下文与角色认知前端技术方案

## 背景

本文档对应 PRD：[story-context-prd.md](./story-context-prd.md) 和服务端技术方案：[story-context-server.md](./story-context-server.md)。

008 服务端会把现有“角色摘要”系统替换为“故事上下文”系统。前端不参与上下文抽取、归一化和生成约束，但需要适配新的共享契约、实时事件、HTTP 调试接口和页面状态文案。

现有前端已经支持故事线列表、详情、新建、续写、重写、互动对话、横向 Reader、FAB + 底部抽屉。当前唯一与旧 summary 强耦合的前端能力是：

- `storylineApi.getStorylineSummary` 请求 `/storylines/:id/summary`。
- `storyRealtimeApi` 识别 `story.summary.started` 并回调 `onSummaryStarted`。
- `StoryPage` 使用 `summarizing` 生成状态和“正在记录角色摘要...”文案。
- `StorySummaryDrawer` 在详情页展示角色摘要。
- 最新生成元信息区域展示“查看角色摘要”按钮。

本期前端目标是移除用户可见的角色摘要入口，把生成阶段语义升级为“更新故事上下文”，并新增一个隐藏调试路由用于查看 `StoryContextSnapshot`。

## 已确认决策

- 普通详情页不展示故事上下文入口。
- 移除最新生成信息里的“查看角色摘要”按钮。
- 删除或停用 `StorySummaryDrawer`。
- 新增隐藏调试路由：`/storylines/:storylineId/context`。
- 调试页进入时拉取 context，并提供“刷新”按钮。
- 调试页不自动轮询。
- 调试页展示结构化只读视图和原始 JSON。
- 结构化视图顺序为：
  - 角色认知。
  - 当前场景。
  - 世界事实。
  - 原始 JSON。
- 角色认知使用移动端友好的卡片展示。
- 世界事实按 `visibility` 分组展示。
- 原始 JSON 使用 `<pre>` 格式化展示，不做复制按钮。
- `GET /context` 返回 `context: null` 时显示空态说明，不视为错误。
- context 调试页遇到 404 时展示“故事线不可用”错误页。
- 生成阶段状态从 `summarizing` 改为 `updatingContext`。
- 实时回调从 `onSummaryStarted` 改为 `onContextStarted`。
- 用户侧文案从“正在记录角色摘要...”改为“正在更新故事上下文...”。
- 前端验证命令包含 `pnpm --filter @kimiko/web typecheck`、`pnpm --filter @kimiko/web lint`、`pnpm --filter @kimiko/web build`。

## 非目标

- 本期不做 context 编辑。
- 本期不做正式用户入口。
- 本期不在故事详情页常驻展示 context。
- 本期不把 context 塞进 `StorylineSnapshot`。
- 本期不做 JSON 复制按钮。
- 本期不做可展开树形 JSON 编辑器。
- 本期不做 context 自动轮询。
- 本期不保留旧 `/summary` 前端调用。

## 现有前端约束

- 前端使用 React + React Router。
- 样式使用 Tailwind CSS v4。
- 共享契约来自 `@kimiko/schema`。
- HTTP API 客户端集中在 `packages/web/src/story/storylineApi.ts`。
- WebSocket 客户端集中在 `packages/web/src/story/storyRealtimeApi.ts`。
- `StoryPage` 当前管理生成状态、草稿、临时正文、Reader、FAB、抽屉和旧 summary drawer。
- `App.tsx` 当前路由包含：
  - `/`
  - `/storylines`
  - `/storylines/new`
  - `/storylines/:storylineId`
  - `/login`
  - `/register`
- TypeScript 代码必须保持严格类型安全。
- 类型导入使用 `import type`。
- 非原始值 `useState`、`useRef` 必须显式标注泛型。
- 新增 Tailwind 类优先使用 v4 canonical 写法，例如 `border-(--border)`。

## 共享契约影响

### 新增 `StoryContextSnapshot`

前端从 `@kimiko/schema` 引入：

```ts
import type { StoryContextSnapshot } from "@kimiko/schema";
```

前端只消费最终 snapshot，不消费服务端内部 draft schema。

### 新增 `GetStorylineContextResponseSchema`

`storylineApi` 新增 `getStorylineContext`，使用共享 schema 校验响应：

```ts
GetStorylineContextResponseSchema;
```

响应结构：

```ts
{
  context: StoryContextSnapshot | null;
}
```

### WebSocket 事件改名

旧事件：

```text
story.summary.started
```

新事件：

```text
story.context.started
```

前端不再识别旧事件。项目不考虑兼容旧服务端。

### 错误码

新增：

```text
STORY_CONTEXT_FAILED
```

前端可继续显示服务端返回的 `message`。如需要兜底，使用通用文案：

```text
生成失败，请稍后重试
```

## 文件调整

需要调整：

- `packages/web/src/App.tsx`
  - 新增隐藏路由 `/storylines/:storylineId/context`。
  - 新增 `StorylineContextRoute` route wrapper。
- `packages/web/src/story/storylineApi.ts`
  - 移除 summary 类型和请求。
  - 新增 `getStorylineContext`。
- `packages/web/src/story/storyRealtimeApi.ts`
  - `onSummaryStarted` 改为 `onContextStarted`。
  - `story.summary.started` 改为 `story.context.started`。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 移除 summary drawer 相关 state、handler、API 调用和渲染。
  - `summarizing` 状态改为 `updatingContext`。
  - `TemporaryTextStatus` 同步改名。
  - `LatestGenerationMetadata` 移除 `onOpenSummary` 和按钮。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - `temporaryTextStatus` union 从 `"summarizing"` 改为 `"updatingContext"`。
  - 文案改为“正在更新故事上下文...”。
- `packages/web/src/pages/story/StoryContextDebugPage.tsx`
  - 新增隐藏调试页面。
- `packages/web/src/pages/story/StoryContextDebugView.tsx`
  - 新增 context 纯展示组件。
- `packages/web/src/pages/story/StorySummaryDrawer.tsx`
  - 删除。

不需要调整：

- `StoryActionFab`
- `StoryActionDrawer`
- `StorylineComposer`
- `StorylineListPage`
- `StorylineReader` 的 page/dialogue 分组逻辑
- `storylineSegmentUtils`

## API Client 设计

### 移除 Summary API

移除：

```ts
StoryCharacterSummarySnapshot;
GetStorylineSummaryResponseSchema;
GetStorylineSummaryResult;
getStorylineSummary;
defaultSummaryErrorMessage;
```

### 新增 Context API

新增默认错误文案：

```ts
const defaultContextErrorMessage = "获取故事上下文失败，请稍后重试";
```

新增 result 类型：

```ts
export type GetStorylineContextResult =
  | Readonly<{
      status: "success";
      context: StoryContextSnapshot | null;
    }>
  | Readonly<{ status: "authRequired" }>
  | Readonly<{ status: "notFound"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;
```

新增方法：

```ts
export async function getStorylineContext(
  storylineId: StorylineId,
): Promise<GetStorylineContextResult> {
  // GET /storylines/:storylineId/context
}
```

处理规则：

- 无登录态：`authRequired`。
- `401`：清理 session，返回 `authRequired`。
- `404`：返回 `notFound`。
- 非 ok：返回 `failed`。
- schema parse 失败：返回 `failed`。
- 成功：返回 `context`，允许为 `null`。

## Realtime Client 设计

### Callback 改名

当前：

```ts
export interface StoryRealtimeGenerationCallbacks {
  readonly onSummaryStarted: () => void;
}
```

改为：

```ts
export interface StoryRealtimeGenerationCallbacks {
  readonly onContextStarted: () => void;
}
```

### Event Switch 改造

当前：

```ts
case "story.summary.started":
  callbacks.onSummaryStarted();
  return;
```

改为：

```ts
case "story.context.started":
  callbacks.onContextStarted();
  return;
```

说明：

- 不保留旧事件分支。
- 如果服务端仍发旧事件，`StoryRealtimeServerEventSchema` 应 parse 失败，前端走 unknown error。这符合本期不兼容旧协议的策略。

## StoryPage 改造

### 状态命名

当前：

```ts
type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
  | "summarizing"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";
```

改为：

```ts
type StorylinePageStatus =
  | "loading"
  | "empty"
  | "ready"
  | "connecting"
  | "streaming"
  | "updatingContext"
  | "completed"
  | "cancelled"
  | "failed"
  | "restoreFailed";
```

`isGenerating` 更新：

```ts
const isGenerating =
  status === "connecting" ||
  status === "streaming" ||
  status === "updatingContext";
```

`TemporaryTextStatus` 更新：

```ts
type TemporaryTextStatus = "streaming" | "updatingContext" | null;
```

`getTemporaryTextStatus` 更新：

```ts
function getTemporaryTextStatus(
  status: StorylinePageStatus,
): TemporaryTextStatus {
  switch (status) {
    case "streaming":
      return "streaming";
    case "updatingContext":
      return "updatingContext";
    default:
      return null;
  }
}
```

### 移除 Summary State

移除：

```ts
type SummaryDrawerStatus = "idle" | "loading" | "success" | "failed";
const summaryFailureMessage = "获取角色摘要失败，请稍后重试";
const [isSummaryDrawerOpen, setIsSummaryDrawerOpen] = useState(false);
const [summaryDrawerStatus, setSummaryDrawerStatus] =
  useState<SummaryDrawerStatus>("idle");
const [characterSummary, setCharacterSummary] =
  useState<StoryCharacterSummarySnapshot | null>(null);
const [summaryErrorMessage, setSummaryErrorMessage] = useState(
  summaryFailureMessage,
);
```

移除 handler：

```ts
handleOpenSummary;
handleRetrySummary;
loadSummary;
```

`restoreStoryline` 中也移除 summary state reset。

### Realtime Callback

当前：

```ts
onSummaryStarted() {
  shouldFollowScrollRef.current = intent.type !== "rewrite" && isNearBottom();
  setStatus("summarizing");
}
```

改为：

```ts
onContextStarted() {
  shouldFollowScrollRef.current = intent.type !== "rewrite" && isNearBottom();
  setStatus("updatingContext");
}
```

### 最新生成元信息

当前 `LatestGenerationMetadata` 包含“查看角色摘要”按钮。

改造为纯展示组件：

```ts
interface LatestGenerationMetadataProps {
  readonly metadata: StorylineGenerationMetadata;
}
```

渲染只保留：

```text
模型：xxx / 耗时：xxxms / Token：xxx
```

不展示 context 调试入口。

### 临时正文文案

`TemporaryGeneratedText`：

```tsx
{
  status === "streaming" ? "正在生成..." : "正在更新故事上下文...";
}
```

## StorylineReader 改造

只改状态命名和文案。

Props：

```ts
temporaryTextStatus: "streaming" | "updatingContext" | null;
```

内部展示：

```tsx
{
  status === "streaming" ? "正在生成..." : "正在更新故事上下文...";
}
```

Reader 的横向分页、dialogue child、temporary append、rewrite inline 展示逻辑保持不变。

## 隐藏调试路由

### App 路由

新增：

```tsx
<Route
  path="/storylines/:storylineId/context"
  element={
    <RequireAuth>
      <StorylineContextRoute />
    </RequireAuth>
  }
/>
```

推荐放在 `/storylines/:storylineId` 路由之前。React Router 会做路径 ranking，但显式放前面更清晰。

新增 route wrapper：

```tsx
function StorylineContextRoute(): JSX.Element {
  const { storylineId } = useParams<"storylineId">();
  if (storylineId === undefined || storylineId.length === 0) {
    return <Navigate to="/storylines" replace />;
  }

  return <StoryContextDebugPage storylineId={storylineId} />;
}
```

## StoryContextDebugPage 设计

### 职责

`StoryContextDebugPage` 负责：

- 从 route 接收 `storylineId`。
- 调用 `getStorylineContext`。
- 管理 loading / success / empty / failed / notFound 状态。
- 处理 authRequired 跳转。
- 提供“刷新”和“返回故事”按钮。
- 把成功的 context 交给 `StoryContextDebugView`。

不负责：

- context 字段内部排版细节。
- context 编辑。
- 生成流程状态同步。

### Props

```ts
interface StoryContextDebugPageProps {
  readonly storylineId: StorylineId;
}
```

### 状态

```ts
type StoryContextDebugPageStatus =
  "loading" | "success" | "empty" | "failed" | "notFound";

const [status, setStatus] = useState<StoryContextDebugPageStatus>("loading");
const [context, setContext] = useState<StoryContextSnapshot | null>(null);
const [errorMessage, setErrorMessage] = useState(defaultContextErrorMessage);
```

非原始值 state 必须显式泛型。

### 拉取逻辑

页面挂载和 `storylineId` 变化时拉取：

```ts
useEffect(() => {
  isMountedRef.current = true;
  void loadContext();
  return () => {
    isMountedRef.current = false;
  };
}, [loadContext]);
```

使用 request id 防止乱序覆盖：

```ts
const requestIdRef = useRef<number>(0);
```

`loadContext`：

- 设置 `loading`。
- 调用 `getStorylineContext(storylineId)`。
- `authRequired` -> navigate login。
- `notFound` -> `notFound`。
- `failed` -> `failed`。
- `success` + `context === null` -> `empty`。
- `success` + context -> `success`。

### 页面布局

沿用故事页的 mobile-first 卡片风格：

- 顶部固定 header 不需要复用 StoryPage header。
- 页面主体 `max-w-3xl`。
- header 包含：
  - 标题：`故事上下文调试`
  - 副标题：`只读查看当前服务端保存的 StoryContextSnapshot`
  - 返回故事按钮。
  - 刷新按钮。

推荐按钮：

```text
返回故事
刷新
```

返回路径：

```ts
`/storylines/${encodeURIComponent(storylineId)}`;
```

### 空态

`context === null` 时：

```text
暂无故事上下文
下一次成功生成后，服务端会建立 StoryContextSnapshot。
```

展示“返回故事”按钮。

### 404

展示：

```text
故事线不可用
故事线不存在或已不可用。
```

提供：

- 返回故事列表。
- 重试。

不自动跳转。

## StoryContextDebugView 设计

### 职责

`StoryContextDebugView` 是纯展示组件：

```ts
interface StoryContextDebugViewProps {
  readonly context: StoryContextSnapshot;
}
```

展示顺序：

1. 角色认知。
2. 当前场景。
3. 世界事实。
4. 原始 JSON。

### 角色认知

每个角色一张卡。

卡片头部：

- `name`
- `id`
- aliases
- identity
- currentStatus

分区展示：

- traits
- motivations
- relationships
- beliefs
- opinions
- actionTendencies
- sourceSegmentIds

Belief 展示建议：

```text
[true] 他知道门锁住了。
关联事实：fact_1, fact_2
来源：12, 13
```

`truthStatus` 样式：

- `true`：普通标签。
- `false`：使用 danger 色弱提示，方便定位误解。
- `unknown`：使用普通边框标签。

空数组不渲染对应分区，避免卡片噪音。

### 当前场景

展示字段：

- location
- timeLabel
- presentCharacterIds
- observableFactIds
- sceneStatus
- sourceSegmentIds

`presentCharacterIds` 和 `observableFactIds` 使用 tag list。

### 世界事实

按 `visibility` 分组：

1. `observable`
2. `public`
3. `hidden`

每组展示 fact 卡片：

- id
- kind
- status
- text
- sourceSegmentIds

`hidden` 分组可以使用较弱但醒目的样式，例如 border danger tint，便于调试是否误入可观察事实。

如果某组为空，显示短文案：

```text
暂无 hidden 事实。
```

### 原始 JSON

使用：

```tsx
<pre className="overflow-x-auto whitespace-pre text-xs leading-5">
  {JSON.stringify(context, null, 2)}
</pre>
```

外层使用卡片容器，移动端允许横向滚动。

不提供复制按钮。

## 样式策略

- 使用现有 CSS 变量：
  - `--panel-bg`
  - `--border`
  - `--text`
  - `--text-h`
  - `--input-bg`
  - `--accent`
  - `--danger`
  - `--danger-bg`
- Tailwind v4 变量类使用 canonical 写法：
  - `border-(--border)`
  - `bg-(--panel-bg)`
  - `text-(--text-h)`
- 页面优先移动端：
  - 单列卡片。
  - `max-w-3xl`。
  - 长 JSON 横向滚动。
  - tag 自动换行。

## 错误处理

### Context API

`getStorylineContext` 返回 failed 时，页面展示：

```text
获取故事上下文失败，请稍后重试
```

提供“重试”按钮。

### Auth

`authRequired` 时：

```ts
void navigate("/login", { replace: true });
```

与现有故事线页面保持一致。

### Realtime

`STORY_CONTEXT_FAILED` 走现有 `onError` 流程：

- create：展示页面内 generation status message。
- append / rewrite / dialogue：toast error。
- 清除临时正文。
- 正式故事线不变。

前端不需要为该错误码做特殊文案。保留 `STORY_SEGMENT_NOT_REWRITABLE` 的特殊文案即可。

## 测试计划

### Schema 接入

依赖 `@kimiko/schema` 更新后，前端 typecheck 应覆盖：

- `StoryContextSnapshot` 类型可被导入。
- `GetStorylineContextResponseSchema` 可被 `storylineApi` 使用。
- `StoryRealtimeServerEventSchema` 支持 `story.context.started`。
- 旧 `StoryCharacterSummarySnapshot` 不再被 web 包使用。

### API Client

建议通过单元测试或轻量 mock 覆盖：

- `getStorylineContext` 成功返回 context。
- `context: null` 返回 success。
- 401 清理 session 并返回 authRequired。
- 404 返回 notFound。
- schema parse 失败返回 failed。

当前仓库 web 包没有既有测试体系时，至少通过 typecheck 和手测覆盖。

### StoryPage

手测或组件测试覆盖：

- 收到 `story.context.started` 后进入 `updatingContext`。
- 临时正文显示“正在更新故事上下文...”。
- context 阶段取消后不保存正式故事线。
- context 阶段失败后清除临时正文，正式故事线不变。
- 详情页不再出现“查看角色摘要”按钮。
- 生成成功仍按 create / append / dialogue / rewrite 原规则清空对应草稿。

### Context Debug Page

覆盖：

- 访问 `/storylines/:id/context` 自动拉取。
- success + context 展示结构化视图和 JSON。
- success + null 展示空态。
- failed 展示错误和重试。
- notFound 展示“故事线不可用”。
- authRequired 跳转登录。
- 刷新按钮会重新拉取。
- 返回故事按钮跳回 `/storylines/:id`。

### 验证命令

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```

## 实施步骤

1. 等服务端和 `@kimiko/schema` 完成 context 契约变更。
2. 更新 `storyRealtimeApi`：`onSummaryStarted` -> `onContextStarted`。
3. 更新 `storylineApi`：移除 summary API，新增 context API。
4. 更新 `StoryPage`：状态改名、移除 summary drawer 和按钮。
5. 更新 `StorylineReader`：临时状态命名和文案。
6. 新增 `StoryContextDebugPage`。
7. 新增 `StoryContextDebugView`。
8. 更新 `App.tsx` 路由。
9. 删除 `StorySummaryDrawer.tsx`。
10. 运行 typecheck、lint、build。
11. 浏览器手测生成流程和隐藏 context 调试页。

## 风险与对策

### 隐藏路由被误认为正式功能

风险：用户直接访问 `/storylines/:id/context` 会看到调试页面。

对策：

- 页面标题和说明明确写“调试”与“只读”。
- 不在普通详情页提供入口。
- 不提供编辑能力。

### Context JSON 过大

风险：长故事线 context 很大，移动端渲染 JSON 可能占用较多空间。

对策：

- JSON 放在结构化视图之后。
- `<pre>` 容器横向滚动。
- 不自动展开复杂树组件，减少状态复杂度。

### 事件命名切换导致旧服务端不可用

风险：前端只识别 `story.context.started`，旧服务端发 `story.summary.started` 会失败。

对策：

- 本项目允许不兼容旧协议。
- 前后端同批实现和验证。

### Summary 残留引用

风险：删除旧抽屉后仍有 `summary` 命名残留，导致概念混乱。

对策：

- 使用 `rg "summary|Summary|角色摘要|summarizing"` 检查 web 包。
- 只允许历史文档中存在旧词。

### 调试页与详情页状态不同步

风险：用户在另一个页面生成后，调试页不会自动刷新。

对策：

- 本期不自动轮询。
- 提供“刷新”按钮。
- 文档明确调试页是按需查看。
