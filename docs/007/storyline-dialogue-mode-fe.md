# 故事线互动对话模式前端技术方案

## 背景

本文档对应设计方案：[storyline-dialogue-mode.md](./storyline-dialogue-mode.md)。

本期目标是在已有故事线详情页中增加「互动对话」前端能力。用户在最新章节页通过右下角 FAB 打开动作菜单，选择「续写」「重写」或「互动」。互动模式下，用户输入一段角色发言或动作，前端通过现有 WebSocket 实时生成链路提交 `mode: "dialogue"`，并把流式结果附加展示在当前最新章节末尾。

本期同时调整已有详情页输入形态：已有故事线详情页不再常驻固定底部续写区，改为 FAB + 底部抽屉；新建故事线和空状态继续保留当前固定底部输入流程。

## 已确认决策

- 仅已有故事线详情页使用 FAB + 底部抽屉。
- `/storylines/new` 和 `/` 最近故事线为空时，继续保留当前固定底部输入流程。
- 现有 `StorylineComposer` 保留给新建页和空状态使用。
- 已有故事线详情页新增 `StoryActionFab` 组件。
- 已有故事线详情页新增 `StoryActionDrawer` 组件。
- FAB 菜单和底部抽屉都支持 `Esc` 关闭。
- 打开底部抽屉时自动聚焦 textarea。
- 底部抽屉打开时隐藏 FAB。
- 点击抽屉外关闭抽屉，但不清空草稿。
- 提交生成后抽屉立即关闭。
- 失败或取消后不自动重新打开抽屉。
- append、rewrite、dialogue 三种草稿独立保存。
- 离开故事详情页时，未提交的 append、rewrite、dialogue 草稿都要触发确认。
- 旧的 generated 段落内文字「重写」按钮移除。
- 右下角 FAB 只在空闲且当前显示最新章节页时展示。
- 生成中右下角 FAB 在任意章节都展示为取消 icon。
- FAB 图标使用 `lucide-react`。
- toast 使用 `sonner`。
- toast 位置为顶部居中，自动消失时间 3 秒。
- 失败和取消显示 toast。
- 成功不显示 toast。
- dialogue segment 不作为独立横向页，而是附加在上一章节页末尾。
- 多条 dialogue segment 在章节页中逐条分隔展示。
- 每条 dialogue segment 使用小分隔标题，例如 `互动`。
- Reader 页数排除 dialogue segment，只统计 initial 和 append 章节页。
- Reader 计算出的 `pageCount` 必须与服务端列表字段 `chapterCount` 口径一致。
- 带有 dialogue 的章节页，页码类型仍显示章节自身类型：`初始正文` 或 `续写`。
- dialogue 生成中不新增横向页，而是在最新章节页末尾展示 `互动中` 临时块。
- dialogue 生成成功后保持在当前最新章节页，不做额外横向重定位。
- 如果最新 segment 是 dialogue，重写目标就是这条 dialogue segment。
- 重写 dialogue 时，临时重写正文展示在原 dialogue 块下方。
- dialogue 输入为空的字段错误文案为：`请输入互动内容`。
- 本期前端验证命令包含 `pnpm typecheck`、`pnpm lint`、`pnpm build`。

## 现有前端约束

- 前端使用 React、React Router、Tailwind CSS v4。
- 共享契约来自 `@kimiko/schema`。
- 实时生成通过 `startStoryRealtimeGeneration(payload, callbacks)` 发起。
- `StoryPage` 当前负责：
  - 故事线恢复。
  - 生成状态。
  - 初始正文、续写、重写草稿。
  - 固定底部 Composer。
  - 生成错误内联消息。
  - 角色摘要抽屉。
- `StorylineReader` 当前把每个 `StorylineSegment` 直接映射为一个横向 page。
- `StorylineReader` 当前内部维护 `currentPageIndex`，外层 `StoryPage` 不知道用户是否正在查看最新页。
- `StorylineReader` 当前用 `ResizeObserver` 动态同步横向滚动容器高度。
- `StorylineComposer` 当前是 fixed bottom 表单，支持 append/rewrite 两种模式。
- web 包依赖版本通过 `pnpm-workspace.yaml` catalog 管理。
- TypeScript 代码必须保持严格类型安全。
- 类型导入使用 `import type`。
- 非原始值 `useState`、`useRef` 必须显式标注泛型。
- 新增 Tailwind 类优先使用 v4 canonical 写法，例如 `border-(--border)`，避免新增 `suggestCanonicalClasses` 诊断。

## 依赖调整

新增前端依赖：

- `lucide-react`
- `sonner`

仓库使用 catalog 管理依赖版本，因此需要同时调整：

- `pnpm-workspace.yaml`
  - catalog 增加 `lucide-react`。
  - catalog 增加 `sonner`。
- `packages/web/package.json`
  - dependencies 增加 `"lucide-react": "catalog:"`。
  - dependencies 增加 `"sonner": "catalog:"`。

推荐通过包管理器解析当前稳定版本，再把版本写入 catalog。不要只在 `packages/web/package.json` 写具体版本。

## 共享契约影响

前端需要消费 007 共享契约中的两个核心变化。

### `StorylineGeneratedSegment.generationMode`

generated segment 新增：

```ts
generationMode: "append" | "dialogue";
```

前端规则：

- `generationMode: "append"` 生成章节页。
- `generationMode: "dialogue"` 附加到当前最后一个章节页。
- create 首个 generated segment 在前端视为 append。
- rewrite 不改变目标 segment 的 `generationMode`。

### `StorylineListItem.chapterCount`

列表项新增：

```ts
chapterCount: number;
```

前端规则：

- `segmentCount` 继续表示物理 segment 总数：initial + append + dialogue。
- `chapterCount` 表示 Reader 章节页数：initial + append。
- 故事线列表卡片应显示 `chapterCount`，避免连续互动导致列表中的章节数暴涨。
- 列表 preview 仍展示服务端返回的最新 segment 文本；如果最新是 dialogue，就展示最新互动文本。

### `StoryContinueDialoguePayload`

`StoryContinuePayload` 新增：

```ts
{
  mode: "dialogue";
  storylineId: StorylineId;
  input: string;
}
```

前端规则：

- `input` 来自 dialogue 抽屉 textarea。
- `input` trim 后不能为空。
- `input` 最大长度 1000。
- 前端不解析角色名。
- 前端不拼接用户原文和模型输出。
- 前端只展示服务端流式返回的模型输出。

## 文件调整

需要调整：

- `pnpm-workspace.yaml`
  - 增加 `lucide-react` 和 `sonner` catalog。
- `packages/web/package.json`
  - 增加 `lucide-react` 和 `sonner` dependencies。
- `packages/web/src/App.tsx`
  - 接入 `sonner` 的 `<Toaster />`。
- `packages/web/src/pages/story/StoryPage.tsx`
  - 拆分已有故事线详情页和新建/空状态的输入入口。
  - 新增 dialogue 草稿和字段错误。
  - 新增 action drawer 状态。
  - 新增 Reader viewport 状态。
  - 新增 dialogue payload 校验。
  - 新增 dialogue 临时文本处理。
  - 用 toast 替换已有故事线详情页生成失败/取消内联消息。
  - 离开确认包含 dialogue 草稿。
- `packages/web/src/pages/story/StorylineReader.tsx`
  - 从 segment page 改为章节 page 分组。
  - dialogue segment 附加展示。
  - 移除段落内「重写」按钮。
  - 向外回传当前 viewport 状态。
  - 支持 dialogue 临时块。
  - 支持 dialogue segment 的 inline rewrite 临时块。
- `packages/web/src/pages/story/StoryActionFab.tsx`
  - 新增 FAB 和动作菜单组件。
- `packages/web/src/pages/story/StoryActionDrawer.tsx`
  - 新增底部抽屉组件。
- `packages/web/src/pages/story/StorylineComposer.tsx`
  - 保留给新建/空状态。
  - 不再服务已有故事线详情页。
- `packages/web/src/pages/story/StorylineListPage.tsx`
  - 列表卡片计数文案改用 `chapterCount`。
  - 推荐文案从 `共 X 段` 改为 `共 X 章` 或 `共 X 页`。

不需要调整：

- `packages/web/src/story/storyRealtimeApi.ts`
  - 现有 API 已接受 `StoryContinuePayload`，共享 schema 扩展后可自然接收 dialogue。
  - `onError` 已传结构化错误。
- `packages/web/src/story/storylineApi.ts`
  - HTTP 恢复接口仍返回完整 `StorylineSnapshot`。
- `packages/web/src/pages/story/StorySummaryDrawer.tsx`
  - 角色摘要查看逻辑不变。

## 状态模型

### Action Mode

新增统一动作模式：

```ts
type StoryActionMode = "append" | "rewrite" | "dialogue";
```

`StorylineComposerMode` 可以保留为：

```ts
export type StorylineComposerMode = "append" | "rewrite";
```

说明：

- `StorylineComposerMode` 继续服务新建/空状态。
- 已有故事线详情页不再依赖 `StorylineComposerMode` 控制输入区。
- `StoryActionMode` 服务 FAB 动作和底部抽屉。

### StoryPage State

推荐新增或调整状态：

```ts
const [appendInstruction, setAppendInstruction] = useState("");
const [rewriteInstruction, setRewriteInstruction] = useState("");
const [dialogueInput, setDialogueInput] = useState("");
const [rewriteTargetSegmentId, setRewriteTargetSegmentId] =
  useState<StorylineSegmentId | null>(null);
const [activeDrawerMode, setActiveDrawerMode] =
  useState<StoryActionMode | null>(null);
const [activeGenerationIntent, setActiveGenerationIntent] =
  useState<GenerationIntent | null>(null);
const [temporaryAppendText, setTemporaryAppendText] = useState("");
const [temporaryDialogueText, setTemporaryDialogueText] = useState("");
const [temporaryRewrite, setTemporaryRewrite] =
  useState<RewriteDraftState | null>(null);
const [readerViewport, setReaderViewport] =
  useState<StorylineReaderViewportState | null>(null);
```

`GenerationIntent` 扩展：

```ts
type GenerationIntent =
  | Readonly<{ type: "create" }>
  | Readonly<{ type: "append" }>
  | Readonly<{ type: "rewrite"; segmentId: StorylineSegmentId }>
  | Readonly<{ type: "dialogue" }>;
```

字段错误扩展：

```ts
interface StorylineFieldErrors {
  initialStoryText?: string;
  appendInstruction?: string;
  rewriteInstruction?: string;
  dialogueInput?: string;
}
```

Reader viewport：

```ts
interface StorylineReaderViewportState {
  readonly currentPageIndex: number;
  readonly pageCount: number;
  readonly isViewingLatestPage: boolean;
}
```

## StoryActionFab 设计

### 职责

`StoryActionFab` 负责：

- 展示右下角主 FAB。
- 展开和收起动作菜单。
- 展示透明遮罩。
- 根据可用动作展示动作按钮。
- 生成中展示取消按钮。
- 处理 `Esc` 关闭菜单。

`StoryActionFab` 不负责：

- 校验输入。
- 组装 payload。
- 管理 textarea 草稿。
- 判断 Reader 当前页。

### Props

推荐 props：

```ts
export type StoryActionKind = "append" | "rewrite" | "dialogue";

interface StoryActionFabProps {
  readonly availableActions: readonly StoryActionKind[];
  readonly isGenerating: boolean;
  readonly isVisible: boolean;
  readonly onCancelGeneration: () => void;
  readonly onSelectAction: (action: StoryActionKind) => void;
}
```

### 显示规则

`StoryPage` 控制 `isVisible`：

```ts
const shouldShowActionFab =
  storyline !== null &&
  activeDrawerMode === null &&
  status !== "loading" &&
  status !== "restoreFailed" &&
  (isGenerating || readerViewport?.isViewingLatestPage === true);
```

规则：

- 抽屉打开时隐藏 FAB。
- 生成中忽略当前页，任意章节都展示取消 FAB。
- 空闲时必须正在查看最新章节页才展示 FAB。
- `storyline === null` 时不展示 FAB。

### 可用动作

已有故事线详情页空闲时：

- append 总是可用。
- dialogue 总是可用。
- rewrite 仅在存在最新 generated segment 时可用。

推荐计算：

```ts
const latestGeneratedSegmentId = getLatestGeneratedSegmentId(
  storyline?.segments ?? [],
);

const availableActions: readonly StoryActionKind[] =
  latestGeneratedSegmentId === null
    ? ["append", "dialogue"]
    : ["append", "rewrite", "dialogue"];
```

菜单视觉顺序从上到下：

```text
续写
重写
互动
```

如果 rewrite 不可用，隐藏重写按钮，不保留占位。

### 图标

使用 `lucide-react`：

- 默认主 FAB：`Plus`
- 关闭菜单：`X`
- 续写：`PenLine`
- 重写：`RefreshCcw`
- 互动：`MessageCircle`
- 取消生成：`CircleStop` 或 `Square`

按钮只展示 icon，不展示文字，但必须提供：

- `aria-label="打开故事操作"`
- `aria-label="关闭故事操作"`
- `aria-label="续写"`
- `aria-label="重写"`
- `aria-label="互动"`
- `aria-label="取消生成"`

### 遮罩

菜单展开时渲染全屏透明遮罩：

- fixed inset-0。
- z-index 低于 FAB 菜单，高于页面内容。
- 点击遮罩只收起菜单。
- 点击遮罩不触发底层返回列表、Reader 等事件。

## StoryActionDrawer 设计

### 职责

`StoryActionDrawer` 负责：

- 展示底部抽屉。
- 根据 mode 展示标题、label、placeholder、maxLength。
- 展示字段错误。
- 自动聚焦 textarea。
- 支持 `Esc` 关闭。
- 点击遮罩关闭。
- 提交表单。

`StoryActionDrawer` 不负责：

- 组装 WebSocket payload。
- 管理生成状态。
- 管理 toast。

### Props

推荐 props：

```ts
interface StoryActionDrawerProps {
  readonly error?: string | undefined;
  readonly mode: StoryActionMode;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly value: string;
}
```

如果后续需要禁用提交，可以扩展：

```ts
readonly disabled?: boolean;
```

但本期提交后会立即关闭抽屉，生成中不会展示抽屉，因此可以先不暴露 `isGenerating`。

### 文案

```ts
const actionCopy: Record<
  StoryActionMode,
  Readonly<{
    title: string;
    label: string;
    placeholder: string;
    submitText: string;
    maxLength: number;
  }>
> = {
  append: {
    title: "续写故事",
    label: "续写指令",
    placeholder: "描述接下来要发生的主要情节和人物行动",
    submitText: "生成续写",
    maxLength: 8_000,
  },
  rewrite: {
    title: "重写上一段",
    label: "重写指令",
    placeholder: "例如：不要转变场景，文风更加轻快，增加对气味的描写",
    submitText: "生成重写",
    maxLength: 8_000,
  },
  dialogue: {
    title: "互动对话",
    label: "互动输入",
    placeholder:
      "写一句角色台词或动作，例如：大凡朝厨房喊了一声，让馥冰帮他拿奶茶",
    submitText: "生成互动",
    maxLength: 1_000,
  },
};
```

### 关闭规则

以下操作关闭抽屉：

- 点击关闭按钮。
- 点击抽屉外遮罩。
- 按 `Esc`。
- 提交通过校验并开始生成。

关闭抽屉不清空草稿，不清字段错误。字段错误在用户修改对应字段时清理。

## Reader 分组设计

### Page 模型

`StorylineReader` 需要从 `segment -> page` 改成 `chapter page + dialogue children`。

这个 Page 模型需要和服务端 `chapterCount` 保持同一口径：

- initial segment 计为 1 个 page。
- `generationMode: "append"` 的 generated segment 计为 1 个 page。
- `generationMode: "dialogue"` 的 generated segment 不计为 page，只作为前一个 page 的 child。
- 因此 `StorylineReaderViewportState.pageCount` 应等于服务端列表项 `chapterCount`。

推荐类型：

```ts
interface StorylineDialogueSegmentView {
  readonly id: StorylineSegmentId;
  readonly text: string;
}

type StorylineReaderPage =
  | Readonly<{
      id: StorylineSegmentId;
      kind: "initial";
      text: string;
      dialogueSegments: readonly StorylineDialogueSegmentView[];
    }>
  | Readonly<{
      id: StorylineSegmentId;
      kind: "append";
      text: string;
      dialogueSegments: readonly StorylineDialogueSegmentView[];
    }>
  | Readonly<{
      id: "temporary-append";
      kind: "temporaryAppend";
      text: string;
      dialogueSegments: readonly StorylineDialogueSegmentView[];
    }>;
```

说明：

- initial page 可以拥有 dialogue children，作为兜底兼容。
- append page 对应 `generationMode: "append"` 的 generated segment。
- dialogue segment 不生成 page。
- temporaryAppend page 不承载 dialogue children。

### 分组规则

```ts
type StorylineReaderPageBuilder =
  | {
      id: StorylineSegmentId;
      kind: "initial";
      text: string;
      dialogueSegments: StorylineDialogueSegmentView[];
    }
  | {
      id: StorylineSegmentId;
      kind: "append";
      text: string;
      dialogueSegments: StorylineDialogueSegmentView[];
    }
  | {
      id: "temporary-append";
      kind: "temporaryAppend";
      text: string;
      dialogueSegments: StorylineDialogueSegmentView[];
    };

function buildReaderPages(
  segments: readonly StorylineSegment[],
): StorylineReaderPage[] {
  const pageBuilders: StorylineReaderPageBuilder[] = [];

  for (const segment of segments) {
    if (segment.type === "initial") {
      pageBuilders.push({
        id: segment.id,
        kind: "initial",
        text: segment.text,
        dialogueSegments: [],
      });
      continue;
    }

    if (segment.generationMode === "dialogue") {
      const latestPage = pageBuilders.at(-1);
      if (latestPage === undefined) {
        continue;
      }

      latestPage.dialogueSegments.push({
        id: segment.id,
        text: segment.text,
      });
      continue;
    }

    pageBuilders.push({
      id: segment.id,
      kind: "append",
      text: segment.text,
      dialogueSegments: [],
    });
  }

  return pageBuilders.map((page) => ({
    ...page,
    dialogueSegments: [...page.dialogueSegments],
  }));
}
```

说明：

- 实际实现不要直接 mutate `StorylineReaderPage` 的 readonly 字段。
- 推荐使用内部 mutable builder，最终返回 readonly view。
- 这样既能保留类型安全，又能避免在循环中反复复制大数组。

异常数据处理：

- 如果 dialogue segment 前没有 page，推荐忽略该 dialogue 并保留控制台不可见的安全降级，避免页面白屏。
- 正常数据下，服务端应保证 initial segment 永远存在。

### 页面标签

页码只统计 page，不统计 dialogue children。

标签规则：

- initial page：`初始正文`
- append page：`续写`
- temporaryAppend page：`生成中`

即使当前 page 包含 dialogue children，也不把页码标签改为 `互动`。

### Dialogue 渲染

每条 dialogue 单独渲染：

```tsx
{
  page.dialogueSegments.map((dialogue) => (
    <section key={dialogue.id} className="flex flex-col gap-4">
      <SegmentDivider label="互动" />
      <p className="m-0 whitespace-pre-wrap text-base leading-8 text-(--text-h)">
        {dialogue.text}
      </p>
    </section>
  ));
}
```

重写 dialogue 时，在目标 dialogue 块下方展示：

```text
重写中
```

并保留旧正式 dialogue 正文。

### Temporary Dialogue

新增 `temporaryDialogueText` 和 `temporaryDialogueVisible`。

规则：

- `temporaryDialogueVisible` 为 true 时，在最新正式 page 末尾展示 `互动中`。
- 如果文本为空，展示 `正在连接生成...`。
- streaming 时展示 `正在生成...`。
- summarizing 时展示 `正在记录角色摘要...`。
- 如果服务端输出 `无事发生` 并跳过摘要，前端只会收到 chunk 和 completed，不需要特殊判断。

临时 dialogue 不新增横向 page，因此 `pageCount` 不变化。

## Reader Viewport 回传

`StorylineReader` 新增 prop：

```ts
interface StorylineReaderProps {
  // existing props...
  readonly onViewportChange: (state: StorylineReaderViewportState) => void;
}
```

当 `currentPageIndex` 或 `pages.length` 变化时回传：

```ts
useEffect(() => {
  onViewportChange({
    currentPageIndex: safeCurrentPageIndex,
    pageCount: pages.length,
    isViewingLatestPage: safeCurrentPageIndex === pages.length - 1,
  });
}, [onViewportChange, pages.length, safeCurrentPageIndex]);
```

注意：

- `onViewportChange` 在 `StoryPage` 中用 `useCallback` 包裹，避免无意义循环。
- `pages.length === 0` 时 `isViewingLatestPage` 为 false。
- temporary append page 生成中时 FAB 已经进入取消状态，不依赖该值展示动作菜单。

## Payload 校验

`validatePayload` 扩展 dialogue。

推荐输入：

```ts
interface ValidatePayloadInput {
  readonly actionMode: StoryActionMode | null;
  readonly appendInstruction: string;
  readonly dialogueInput: string;
  readonly initialStoryText: string;
  readonly rewriteInstruction: string;
  readonly rewriteTargetSegmentId: StorylineSegmentId | null;
  readonly storyline: StorylineSnapshot | null;
}
```

已有故事线下：

- `append` 校验 `appendInstruction.trim()` 非空。
- `rewrite` 校验 `rewriteInstruction.trim()` 非空，并要求 `rewriteTargetSegmentId !== null`。
- `dialogue` 校验 `dialogueInput.trim()` 非空。

dialogue payload：

```ts
return {
  success: true,
  payload: {
    mode: "dialogue",
    storylineId: input.storyline.id,
    input: dialogueInput,
  },
  intent: { type: "dialogue" },
};
```

字段错误：

```ts
fieldErrors.dialogueInput = "请输入互动内容";
```

字段错误清理：

- `handleAppendInstructionChange` 清理 `appendInstruction`。
- `handleRewriteInstructionChange` 清理 `rewriteInstruction`。
- `handleDialogueInputChange` 清理 `dialogueInput`。

提交成功开始生成时，清理当前字段错误并关闭抽屉。

## 生成流程

### 打开动作

```ts
function handleSelectStoryAction(action: StoryActionKind): void {
  if (isGenerating) {
    return;
  }

  if (action === "rewrite") {
    const latestSegmentId = getLatestGeneratedSegmentId(
      storyline?.segments ?? [],
    );
    if (latestSegmentId === null) {
      return;
    }
    setRewriteTargetSegmentId(latestSegmentId);
  }

  setActiveDrawerMode(action);
}
```

说明：

- rewrite 目标在打开抽屉时锁定为当前最新 generated segment。
- 如果期间故事线快照变化，提交时仍需要再次校验 target 是否存在。

### 提交生成

提交通过校验后：

- 关闭抽屉：`setActiveDrawerMode(null)`。
- 设置 `activeGenerationIntent`。
- 清空对应临时文本。
- `append`：显示 temporary append page。
- `rewrite`：设置 `temporaryRewrite`。
- `dialogue`：显示 latest page 的 temporary dialogue block。
- 状态设为 `connecting`。
- 调用 `startStoryRealtimeGeneration`。

### Chunk 处理

```ts
onChunk(delta) {
  setStatus("streaming");

  if (intent.type === "rewrite") {
    setTemporaryRewrite((previousDraft) => ({
      targetSegmentId: intent.segmentId,
      text: `${previousDraft?.text ?? ""}${delta}`,
    }));
    return;
  }

  if (intent.type === "dialogue") {
    setTemporaryDialogueText((previousText) => `${previousText}${delta}`);
    return;
  }

  setTemporaryAppendText((previousText) => `${previousText}${delta}`);
}
```

### Completed 处理

完成后：

- 使用 `event.storyline` 替换正式快照。
- 清空所有临时正文。
- 清空 `activeGenerationIntent`。
- 状态设为 `completed`。
- 不显示成功 toast。

草稿清理：

- create：清空 `initialStoryText` 和 `appendInstruction`，跳转详情页。
- append：清空 `appendInstruction`。
- rewrite：清空 `rewriteInstruction` 和 `rewriteTargetSegmentId`。
- dialogue：清空 `dialogueInput`。

定位规则：

- append 完成后停在新 append 页。
- rewrite 完成后停在被重写目标所在页。
- dialogue 完成后保持当前最新页，不额外横向重定位。

### Cancelled 处理

取消后：

- 清空临时正文。
- 清空 `activeGenerationIntent`。
- 状态设为 `cancelled`。
- 不清空草稿。
- 不打开抽屉。
- 显示顶部居中 toast：`已取消生成`。

### Error 处理

失败后：

- 清空临时正文。
- 清空 `activeGenerationIntent`。
- 状态设为 `failed`。
- 不清空草稿。
- 不打开抽屉。
- 显示顶部居中 toast，文案使用 `getGenerationErrorMessage(error)`。

已有故事线详情页不再展示 `GenerationStatusMessage` 内联错误。新建/空状态可以暂时保留现有内联消息，避免扩大范围。

## Toast 设计

使用 `sonner`。

### 接入位置

在 `App.tsx` 中接入：

```tsx
import { Toaster } from "sonner";

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>{/* existing routes */}</Routes>
      <Toaster position="top-center" duration={3000} />
    </BrowserRouter>
  );
}
```

### 使用方式

在 `StoryPage` 中：

```ts
import { toast } from "sonner";

toast.error(getGenerationErrorMessage(error), { duration: 3000 });
toast(generationCancelledMessage, { duration: 3000 });
```

规则：

- 成功不 toast。
- 失败使用 `toast.error`。
- 取消使用中性 toast。
- 鉴权失效不 toast，继续跳转 `/login`。

## 离开确认

`hasUnsavedDraft` 需要包含 dialogue：

```ts
function hasUnsavedDraft(
  initialStoryText: string,
  appendInstruction: string,
  rewriteInstruction: string,
  dialogueInput: string,
): boolean {
  return (
    initialStoryText.trim().length > 0 ||
    appendInstruction.trim().length > 0 ||
    rewriteInstruction.trim().length > 0 ||
    dialogueInput.trim().length > 0
  );
}
```

说明：

- 抽屉关闭不等于草稿删除。
- 隐藏草稿仍属于未提交输入。
- 离开列表时需要继续二次确认。

## 布局与样式

### 页面底部留白

已有故事线详情页不再常驻 fixed Composer，因此可以降低默认 `pb-64`。

建议：

- 新建/空状态保留当前较大的底部 padding，避免 Composer 遮挡。
- 已有故事线详情页只保留 FAB 和安全区需要的 padding。

实现时可以按页面状态拆分 className：

```ts
const mainPaddingClassName = storyline === null ? "pb-64" : "pb-28";
```

### FAB 位置

推荐 Tailwind：

```text
fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))]
z-30 h-14 w-14 rounded-full shadow-[var(--shadow)]
```

桌面端可以保持右下角，不需要改成侧栏。

### 抽屉

推荐：

- fixed inset-x-0 bottom-0。
- z-index 高于遮罩和页面内容。
- 圆角顶部。
- 最大宽度不超过 Reader 内容宽度，移动端占满宽度。
- textarea 最大高度保留 `max-h-40`。

### Toast

sonner 位置使用 top-center。若后续要统一视觉，可通过 sonner 的 className 或 toastOptions 调整颜色；本期优先使用默认样式，减少样式分叉。

## 可访问性

- FAB 和动作按钮必须提供 `aria-label`。
- 图标设置 `aria-hidden`。
- 动作菜单展开时，遮罩按钮或 div 需要能被点击关闭。
- 抽屉打开时 textarea 自动聚焦。
- 抽屉标题使用可被读屏识别的文本。
- 字段错误使用 `role="alert"`。
- textarea 设置 `aria-invalid` 和 `aria-describedby`。
- `Esc` 关闭菜单或抽屉，不清空草稿。
- 抽屉关闭后不强制恢复焦点，本期可以依赖浏览器默认行为；如果实现中焦点丢失明显，再补充 focus restore。

## 风险与处理

### Segment 分组影响现有默认定位

风险：dialogue segment 不再增加 page，`pageIdentity` 不能只用所有 segment id 拼接，否则 dialogue 增加时可能触发不必要横向重定位。

处理：

- page identity 使用 page id 和 dialogue child id 组合。
- dialogue 完成后保持当前 latest page。
- append 完成后才切到新 page。

### Reader pageCount 与服务端 chapterCount 口径不一致

风险：服务端列表展示使用 `chapterCount`，Reader 内部使用 `pageCount`。如果两边对 dialogue 的计数口径不一致，列表中的章节数量会和详情页页码不一致。

处理：

- 前端 Reader pageCount 只统计 initial 和 append page。
- dialogue child 不增加 pageCount。
- StorylineListPage 显示服务端 `chapterCount`，不再显示 `segmentCount`。
- 服务端和前端测试都要覆盖 continuous dialogue 不增加章节数。

### 滚动容器高度需要继续跟随当前页

风险：dialogue 附加到当前页末尾会改变当前页高度。

处理：

- 继续使用当前 `ResizeObserver`。
- temporary dialogue streaming 时也会触发当前 page 高度更新。

### Rewrite target 不再等于 page id

风险：重写 dialogue 时，target segment id 是 dialogue child id，不是 page id。

处理：

- Reader 需要提供 `findPageIndexBySegmentId`，同时搜索 page 主 segment 和 dialogue children。
- `temporaryRewrite.targetSegmentId` 匹配 page id 时显示在主正文下方。
- 匹配 dialogue child id 时显示在该 dialogue 块下方。

### 旧 Composer 与新 Drawer 共存

风险：StoryPage 状态复杂度继续增加。

处理：

- 明确 `StorylineComposer` 只在 `storyline === null` 时渲染。
- 已有故事线详情页只渲染 `StoryActionFab` 和 `StoryActionDrawer`。
- 生成提交逻辑仍统一在 `StoryPage.handleSubmit` 或拆成 `submitStoryGeneration` helper。

## 验证方案

自动验证：

```bash
pnpm typecheck
pnpm lint
pnpm build
```

建议手工验证：

- 打开已有故事线详情页，默认停在最新章节页。
- 最新章节页空闲时显示 FAB。
- 切到非最新页时隐藏 FAB。
- 生成中任意页显示取消 FAB。
- 点击 FAB 展开动作菜单，按钮顺序为续写、重写、互动。
- 点击遮罩只关闭菜单，不触发底层返回列表。
- 点击互动打开底部抽屉，并自动聚焦 textarea。
- dialogue 输入为空提交时显示 `请输入互动内容`。
- 输入 dialogue 后提交，抽屉关闭，最新页末尾出现 `互动中`。
- dialogue chunk 流式展示在最新页末尾，不新增横向页。
- dialogue 完成后仍停在最新章节页，且新内容显示为「互动」块。
- 连续多次 dialogue 时，每条都逐条分隔。
- 连续多次 dialogue 后，列表卡片显示的 `chapterCount` 不随 dialogue 数量增加。
- 最新 segment 是 dialogue 时，重写动作可用。
- 重写 dialogue 时，`重写中` 显示在原 dialogue 块下方。
- 取消生成后显示顶部 toast，草稿保留。
- 失败后显示顶部错误 toast，草稿保留。
- 离开页面时，隐藏的 dialogue 草稿也触发确认。
