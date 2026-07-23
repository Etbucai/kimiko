# 故事详情页横向分页阅读前端技术方案

## 背景

当前故事详情页中，`StorylineReader` 会把 `storyline.segments` 按纵向顺序从上到下拼接展示。随着故事线变长，用户需要不断纵向滚动才能查看前后轮次，阅读和定位都不够清晰。

本期目标是只改造前端详情页展示方式：把每一轮从上下拼接改为左右分页。用户向左滑查看上一页，向右滑查看下一页；滑动放手后页面需要吸附到某一页，不能停在两页中间。

本期不修改服务端接口，不做分页，不改变故事线数据结构。前端继续使用现有 `StorylineSnapshot.segments` 完整快照。

## 已确认决策

- 本期只改前端，不改服务端接口。
- 本期不做服务端分页。
- 初始正文作为第 1 页。
- 每个 generated segment 各占 1 页。
- 进入详情页默认停在最新页。
- 续写生成中追加一个临时新页，并切到该临时页。
- 续写完成后停在新正式页。
- 重写生成中不新增页，在被重写页内展示旧正文和“重写中”草稿。
- 重写完成后停在被重写页。
- 横向吸附优先使用原生 CSS Scroll Snap。
- 放手后必须吸附到完整页面，不允许停在中间。
- 单页正文较长时，不固定续写卡片高度，由正文自然撑开页面高度。
- 横向阅读器显示页码和当前页类型。
- 桌面端不显示上一页/下一页按钮。
- 桌面端支持键盘左右方向键切页。
- 键盘左右方向键只在横向阅读器获得焦点时生效，避免干扰输入框。
- 重写按钮仍然只出现在最新 generated 页。

## 现有前端约束

- `StoryPage` 负责故事线恢复、生成状态、续写/重写草稿和底部输入区编排。
- `StorylineReader` 当前负责纵向渲染完整 `storyline.segments`。
- `StorylineComposer` 固定在底部，用于提交续写或重写。
- 续写临时正文当前由 `temporaryAppendText` 表示。
- 重写临时正文当前由 `temporaryRewrite` 表示。
- 重写能力当前只允许最新 generated segment。
- 前端使用 React、react-router、Tailwind CSS v4。
- 不新增前端第三方依赖。

## 页面模型

### Reader Page

前端将 `StorylineSnapshot.segments` 转换为横向页面数组。

```ts
type StorylineReaderPage =
  | Readonly<{
      kind: "initial";
      id: StorylineSegmentId;
      text: string;
    }>
  | Readonly<{
      kind: "generated";
      id: StorylineSegmentId;
      text: string;
      canRewrite: boolean;
    }>
  | Readonly<{
      kind: "temporaryAppend";
      id: "temporary-append";
      text: string;
    }>;
```

规则：

- initial segment 映射为 `kind: "initial"`。
- generated segment 映射为 `kind: "generated"`。
- 只有最新 generated segment 的 `canRewrite` 为 `true`。
- 当 `temporaryAppendVisible === true` 时，在末尾追加 `kind: "temporaryAppend"` 页面；此时即使 `temporaryAppendText` 为空，也要显示临时页和生成状态。
- `temporaryRewrite` 不生成新页面，而是在目标 generated 页面内部展示。

### 默认页

详情页恢复完成后：

- 如果没有临时生成，默认滚到最后一个正式 page。
- 如果有临时续写页，滚到临时页。
- 空故事线仍显示初始输入，不进入横向阅读器。

## 横向吸附实现

使用原生 CSS Scroll Snap：

```tsx
<article aria-label="故事正文" tabIndex={0}>
  <div className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth">
    <section className="min-w-full snap-center">...</section>
    <section className="min-w-full snap-center">...</section>
  </div>
</article>
```

关键 CSS / Tailwind 规则：

- 外层 reader 可聚焦：`tabIndex={0}`。
- 横向容器：
  - `flex`
  - `overflow-x-auto`
  - `snap-x`
  - `snap-mandatory`
  - `scroll-smooth`
  - `overscroll-x-contain`
- 每页：
  - `min-w-full`
  - `snap-center`
  - `shrink-0`
- 放手后的吸附由浏览器原生 scroll snap 负责。

不采用自定义拖拽逻辑。本期避免自行处理 pointer/touch/momentum，降低移动端滚动冲突风险。

## 页面纵向滚动

每个横向页的正文卡片不固定高度，长文直接撑开页面高度，由 document 负责纵向滚动。

推荐结构：

```tsx
<section className="min-w-full snap-center px-1">
  <div className="rounded-3xl ...">
    ...
  </div>
</section>
```

说明：

- 横向滚动发生在 page 容器上。
- 纵向滚动发生在 document 上。
- 续写卡片不设置 `max-height`、固定高度或 `overflow-y-auto`。
- 当前底部 Composer 是 fixed，因此页面底部仍需要保留足够 padding，避免正文被输入区遮挡。

## 页码与类型提示

横向阅读器需要展示当前页信息。

推荐文案：

```text
第 X / Y 页 · 初始正文
第 X / Y 页 · 续写
第 X / Y 页 · 生成中
```

规则：

- initial 页显示 `初始正文`。
- generated 页显示 `续写`。
- temporaryAppend 页显示 `生成中`。
- 如果当前页正在摘要阶段，临时页或重写草稿下方继续显示 `正在记录角色摘要...`。

当前页索引通过监听横向滚动容器计算：

```ts
const pageIndex = Math.round(scrollLeft / clientWidth);
```

滚动监听需要做边界保护：

- `clientWidth <= 0` 时不更新。
- pageIndex clamp 到 `[0, pages.length - 1]`。

本期不需要 URL query 保存页码。

## 键盘操作

横向 reader 获得焦点时支持：

- `ArrowLeft`：上一页。
- `ArrowRight`：下一页。

规则：

- 只有 reader 或其内部非输入元素聚焦时响应。
- 不在全局 document 上监听方向键。
- 不影响底部 textarea 内的左右光标移动。
- 到达第一页或最后一页时按键无效果。

实现建议：

```ts
function handleReaderKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    scrollToPage(currentPageIndex - 1);
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    scrollToPage(currentPageIndex + 1);
  }
}
```

`scrollToPage` 使用横向容器的 `scrollTo({ left, behavior: "smooth" })`。

## 生成状态处理

### 续写生成

提交续写后：

1. 设置 `temporaryAppendText` 为空字符串。
2. 横向 pages 末尾追加 temporaryAppend 页。
3. 主动滚动到 temporaryAppend 页。
4. chunk 到来后，临时页内展示流式正文。
5. `story.summary.started` 后临时页继续保留正文，并显示 `正在记录角色摘要...`。
6. `story.completed` 后使用正式 `event.storyline` 替换快照。
7. 新 generated segment 成为最后一页。
8. 横向位置保持在新正式页。

注意：

- 当前实现只有 `temporaryAppendText.length > 0` 时才渲染临时正文。本期需要在 connecting/streaming 阶段即创建临时页，即使文本还为空，也要能滚到临时页并显示状态。
- 因此建议新增派生条件：

```ts
const shouldShowTemporaryAppendPage =
  activeGenerationIntent?.type === "append" ||
  activeGenerationIntent?.type === "create";
```

如果当前代码不保留 `activeGenerationIntent` 状态，可以改为保存一个 `temporaryAppendTarget` 或 `isTemporaryAppendPageVisible` 状态。

### 首轮生成

空故事线首轮生成时仍然使用当前独立的 `StoryInitialInput` 和 `TemporaryGeneratedText` 结构。

本期横向 reader 只改造已有 `storyline !== null` 的详情展示。首轮生成成功后跳转到新详情页，并默认停在最新页。

### 重写生成

重写仍然只允许最新 generated 页。

提交重写后：

1. 当前页保持为被重写页。
2. 旧正式正文继续展示。
3. 页内展示 `重写中` 草稿区域。
4. chunk 到来后追加到草稿区域。
5. `story.summary.started` 后继续保留草稿，并显示 `正在记录角色摘要...`。
6. `story.completed` 后正式快照替换旧正文。
7. 横向位置保持在同一页索引。

重写失败或取消：

- 清空重写草稿。
- 保留旧正式正文。
- 保留重写指令和重写模式。
- 横向位置保持在被重写页。

## 自动定位规则

需要主动定位的场景：

- 恢复详情成功：滚到最后一个正式页。
- 续写开始：滚到临时续写页。
- 续写完成：滚到新的最后一页。
- 重写开始：滚到被重写页。
- 重写完成：保持被重写页。

不需要主动定位的场景：

- 用户手动横滑。
- 用户在当前页面内纵向滚动。
- 重写 chunk 到来。

实现上，建议在 `StorylineReader` 中暴露 `currentPageIndex` 内部状态，不把横向滚动状态提升到 `StoryPage`，除非后续需要 URL 同步。

`StoryPage` 可以通过 props 传入定位意图：

```ts
interface StorylineReaderProps {
  activePageTarget:
    | Readonly<{ type: "latest" }>
    | Readonly<{ type: "segment"; segmentId: StorylineSegmentId }>
    | Readonly<{ type: "temporaryAppend" }>;
}
```

更轻量的实现也可以在 `StorylineReader` 内根据 `storyline.segments.length` 和 `temporaryAppend` 状态自动定位。

## 与重写入口的关系

重写按钮规则保持：

- 只在最新 generated 页展示。
- initial 页不展示。
- 旧 generated 页不展示。
- 生成中或摘要中不展示或禁用。

按钮位置：

- 当前页正文 panel 底部右侧。
- 保持现有「重写」按钮样式即可。

## 组件调整

### `StorylineReader`

主要调整：

- 从纵向 `segments.map` 改为横向 pages。
- 新增横向滚动容器 ref。
- 新增当前页 index 状态。
- 新增 scroll 监听更新页码。
- 新增 keydown 处理左右方向键。
- 支持临时 append 页。
- 正文卡片由内容自然撑高页面。
- 保留重写草稿同页展示。

推荐 props：

```ts
interface StorylineReaderProps {
  storyline: StorylineSnapshot;
  temporaryAppendText: string;
  temporaryAppendVisible: boolean;
  temporaryRewrite: RewriteDraftState | null;
  temporaryTextStatus: "streaming" | "summarizing" | null;
  canRewrite: boolean;
  onStartRewrite: (segmentId: StorylineSegmentId) => void;
}
```

说明：

- `temporaryAppendVisible` 解决临时页还没有 chunk 时也需要展示的问题。
- `temporaryAppendText` 只负责正文内容。

### `StoryPage`

主要调整：

- 在续写提交时设置临时 append 页可见。
- 在 append chunk 到来时更新 `temporaryAppendText`。
- 在 append completed/cancelled/error 时隐藏临时 append 页。
- 在 rewrite 开始时保持当前 segment 页。
- 如果当前实现已移除 `activeGenerationIntent` 状态，本期需要恢复一个轻量的生成意图状态，至少用于判断是否展示临时 append 页。

推荐新增状态：

```ts
const [activeGenerationIntent, setActiveGenerationIntent] =
  useState<GenerationIntent | null>(null);
```

用途：

- 判断临时 append 页是否可见。
- 判断生成完成后应该定位到临时页/最新页还是保持重写页。
- 避免只依赖 `temporaryAppendText.length`。

## 验收标准

- 已有故事线详情页使用横向分页展示。
- 初始正文是第 1 页。
- 每个 generated segment 各占 1 页。
- 默认打开详情页时停在最新页。
- 左滑可以查看上一页。
- 右滑可以查看下一页。
- 放手后页面吸附到完整页。
- 页面不能停留在两页中间。
- 长正文会撑开页面高度，并通过页面整体纵向滚动阅读。
- 当前页显示 `第 X / Y 页`。
- 当前页显示页面类型：初始正文、续写或生成中。
- 续写生成时追加临时新页并切到临时页。
- 续写完成后停在新正式页。
- 重写生成时不新增页。
- 重写生成时旧正文和重写草稿同页展示。
- 重写完成后停在被重写页。
- 只有最新 generated 页显示「重写」按钮。
- Reader 获得焦点时，左右方向键可以切页。
- textarea 聚焦时，左右方向键不切页。
- 本期不修改 HTTP 或 WebSocket 服务端接口。
- 本期不请求分页接口。

## 验证

本期实现完成后至少执行：

```bash
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web lint
pnpm --filter @kimiko/web build
```

如需人工验证，重点检查移动端触摸横滑、桌面触控板横滑、长文撑开页面后的纵向滚动、续写临时页和重写同页草稿。
