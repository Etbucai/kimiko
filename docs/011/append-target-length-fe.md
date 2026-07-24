# 续写字数档位前端技术方案

## 背景

本文档对应需求文档：[append-target-length.md](./append-target-length.md)。

`011` 的产品目标是：在已有故事线的 `append` 续写场景中，允许用户选择本轮续写的目标字数，并按用户维度记住该偏好。前端需要在不改动 `create / rewrite / dialogue` 现有交互的前提下，把这个能力接入现有的 `StoryActionDrawer` + `StoryPage` 提交流程。

当前已有故事线详情页的输入模式已经是：

- 通过右下角 FAB 打开 `StoryActionDrawer`。
- `append / rewrite / dialogue` 共用同一个抽屉组件。
- 生成提交统一由 `StoryPage.handleSubmit` 和 `validatePayload` 组装 payload。

因此本期前端重点不是新增一条独立链路，而是在现有 `append` 抽屉中增加一个轻量的长度选择器，并把该选择纳入本地持久化和 `append` payload。

## 已确认决策

- 新增独立前端技术文档：`docs/011/append-target-length-fe.md`。
- 本期只覆盖已有故事线详情页的 `append` 抽屉。
- `/storylines/new` 和 recent 为空时的 `create` 输入流程保持不变。
- `rewrite` 抽屉和 `dialogue` 抽屉不展示长度选择器。
- 长度选择器放在 `append` 抽屉的 textarea 上方。
- 选择器视觉形态为 4 列等宽按钮组。
- 按钮只显示语义文案：`短 / 中 / 长 / 很长`。
- 前端仍维持固定数值映射：
  - `短` => `250`
  - `中` => `500`
  - `长` => `750`
  - `很长` => `1000`
- 提交按钮文案保持 `生成续写`，不附带档位信息。
- 不额外展示“尽量接近”这类可见说明文案。
- 当前用户一旦切换档位，立即写入 `localStorage`。
- 本地缓存缺失、损坏、越界或不属于 4 个支持档位时，前端静默回退到 `1000`，并覆盖坏值。
- `append` 成功、失败、取消后都不重置该偏好。

## 非目标

- 不为 `create` 新建故事接入长度选择器。
- 不为 `rewrite` 或 `dialogue` 接入长度选择器。
- 不提供自定义数字输入框。
- 不按故事线区分长度偏好。
- 不把长度偏好保存到服务端。
- 不改变现有 FAB、抽屉开关和实时生成状态流。
- 不在 UI 中直接展示 `250 / 500 / 750 / 1000` 这组数字文案。

## 现有前端约束

- 前端使用 React + React Router。
- 样式使用 Tailwind CSS v4。
- 类型契约来自 `@kimiko/schema`。
- HTTP / WebSocket 生成入口分别位于：
  - `packages/web/src/story/storylineApi.ts`
  - `packages/web/src/story/storyRealtimeApi.ts`
- 故事页状态集中在 `packages/web/src/pages/story/StoryPage.tsx`。
- 抽屉组件位于 `packages/web/src/pages/story/StoryActionDrawer.tsx`。
- 当前仓库里，浏览器本地存储的既有模式主要在 `packages/web/src/auth/authApi.ts`。
- TypeScript 必须保持严格类型安全：
  - 类型导入使用 `import type`
  - 非原始值 `useState`、`useRef` 必须显式标注泛型

## 共享契约影响

前端不单独定义 `targetLength` 协议，而是直接消费共享 schema。

本期服务端会把 `StoryContinueAppendPayload` 扩展为：

```ts
export const StoryContinueAppendPayloadSchema = z
  .object({
    mode: z.literal("append"),
    storylineId: StorylineIdSchema,
    instruction: z.string().trim().min(1).max(8_000),
    targetLength: z.number().int().min(100).max(1_200),
  })
  .strict();
```

前端规则：

- UI 层只允许用户在 `250 | 500 | 750 | 1000` 四个值里选择。
- 提交 `append` 时，payload 必须带上 `targetLength`。
- `rewrite` 和 `dialogue` payload 不应携带该字段。
- 由于共享契约仍是 `100-1200` 的开放区间，前端需要在本地定义自己的固定 union 类型来约束 UI 选项。

建议新增本地类型：

```ts
export type AppendTargetLength = 250 | 500 | 750 | 1000;

export interface AppendTargetLengthOption {
  readonly value: AppendTargetLength;
  readonly label: "短" | "中" | "长" | "很长";
  readonly assistiveText: string;
}
```

其中 `assistiveText` 用于无障碍说明，例如：

- `短，目标约 250 字`
- `中，目标约 500 字`

原因：UI 不直接显示数字，但辅助技术仍应能读到清晰映射。

## 本地存储设计

建议新增一个轻量 helper 文件：

- `packages/web/src/pages/story/append-target-length-preference.ts`

职责：

- 定义 4 个固定档位与语义文案映射。
- 读写当前用户的长度偏好。
- 对无效缓存执行静默回退和覆盖。

建议导出：

```ts
export type AppendTargetLength = 250 | 500 | 750 | 1000;

export const DEFAULT_APPEND_TARGET_LENGTH: AppendTargetLength = 1000;

export const APPEND_TARGET_LENGTH_OPTIONS: readonly AppendTargetLengthOption[];

export function readAppendTargetLengthPreference(
  userId: string | null,
): AppendTargetLength;

export function writeAppendTargetLengthPreference(
  userId: string | null,
  value: AppendTargetLength,
): void;
```

建议 key 结构：

```ts
const APPEND_TARGET_LENGTH_STORAGE_KEY_PREFIX =
  "kimiko.story.append-target-length";
```

实际 key：

```ts
`${APPEND_TARGET_LENGTH_STORAGE_KEY_PREFIX}:${userId}`;
```

说明：

- 使用 `userId` 而不是 `uniqueName`，因为 `userId` 在现有 auth session 中更适合作为稳定命名空间。
- 当 `userId === null` 时：
  - `read` 直接返回默认值；
  - `write` 直接 no-op；
  - 不抛错。

### 无效缓存处理

`readAppendTargetLengthPreference` 的行为建议固定为：

1. 读取当前用户对应 key。
2. 若不存在，返回 `1000`。
3. 若存在但不是 `250 | 500 | 750 | 1000` 之一：
   - 返回 `1000`
   - 同时把该 key 覆盖为 `1000`

这样可以满足 PRD 中的“静默回退并覆盖坏值”要求，而且不把纠错逻辑散落到 `StoryPage` 内部。

## `StoryPage` 设计

### 新增状态

在 `StoryPage` 中新增：

```ts
const [appendTargetLength, setAppendTargetLength] =
  useState<AppendTargetLength>(() =>
    readAppendTargetLengthPreference(getCurrentStoryUserId()),
  );
```

建议同时新增一个读取当前登录用户 ID 的轻量 helper：

```ts
function getCurrentStoryUserId(): string | null {
  return getStoredAuthSession()?.me.userId ?? null;
}
```

说明：

- 该状态属于“页面级、用户级偏好”，不属于抽屉内部瞬时状态。
- 不应在 `restoreStoryline()` 中重置它。
- 它与 `appendInstruction` 独立；切换故事线只恢复故事内容，不改变长度偏好。

### 变更处理

新增：

```ts
function handleAppendTargetLengthChange(value: AppendTargetLength): void {
  setAppendTargetLength(value);
  writeAppendTargetLengthPreference(getCurrentStoryUserId(), value);
}
```

行为：

- 用户点击某个长度按钮后立即执行。
- 不需要字段级错误。
- 不依赖提交成功。

### Payload 组装

`ValidatePayloadInput` 增加：

```ts
appendTargetLength: AppendTargetLength;
```

`validatePayload` 的 `append` 分支更新为：

```ts
return {
  success: true,
  payload: {
    mode: "append",
    storylineId: input.storyline.id,
    instruction,
    targetLength: input.appendTargetLength,
  },
  intent: { type: "append" },
};
```

其他分支不变：

- `create` 继续不传 `targetLength`
- `rewrite` 不传 `targetLength`
- `dialogue` 不传 `targetLength`

### 提交流程

`handleSubmit()` 本身不需要新增特殊分支，只需要在调用 `validatePayload` 时把 `appendTargetLength` 传进去。

这样可以保持现有结构：

- 抽屉只负责展示和回调
- `StoryPage` 统一组装 payload
- `startStoryRealtimeGeneration` 无需新增分支逻辑，只接受更新后的共享类型

### 完成 / 失败 / 取消

以下事件都不应修改 `appendTargetLength`：

- `onCompleted`
- `onCancelled`
- `onError`
- `restoreStoryline`
- `handleCancelRewrite`

也就是说，当前偏好只由两件事改变：

- 读取本地缓存时的回退修正
- 用户主动点击其他档位

## `StoryActionDrawer` 设计

### 设计目标

保持 `StoryActionDrawer` 依然是一个“轻展示组件”，不让它知道 WebSocket、payload 或页面状态机。

它只新增一个 append 专属的选择器插槽。

### Props 扩展

建议新增一个可选的嵌套 prop，而不是把多个 append 长度字段直接平铺到顶层：

```ts
interface StoryActionDrawerAppendLengthSelector {
  readonly value: AppendTargetLength;
  readonly options: readonly AppendTargetLengthOption[];
  readonly onChange: (value: AppendTargetLength) => void;
}

interface StoryActionDrawerProps {
  readonly error?: string | undefined;
  readonly mode: StoryActionKind;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly value: string;
  readonly appendLengthSelector?:
    StoryActionDrawerAppendLengthSelector | undefined;
}
```

这样做的好处：

- `append` 专属能力被包在一起，不污染 rewrite / dialogue 使用方。
- `StoryActionDrawer` 仍保持清晰边界。
- 后续如果需要补充 `disabled`、`description` 等字段，也只改一个嵌套对象。

### 渲染规则

仅当：

- `mode === "append"`
- `appendLengthSelector !== undefined`

时，渲染长度选择器。

放置顺序：

1. 抽屉标题
2. 长度选择器
3. textarea
4. 错误提示
5. 提交按钮

### 长度选择器结构

视觉上为 4 列按钮组，但实现上推荐使用“原生 radio + 按钮样式 label”的方式，以获得更可靠的单选语义。

建议结构：

```tsx
<fieldset>
  <legend>续写长度</legend>
  <div className="grid grid-cols-4 gap-2">
    {options.map((option) => (
      <label key={option.value}>
        <input type="radio" ... />
        <span>{option.label}</span>
        <span className="sr-only">{option.assistiveText}</span>
      </label>
    ))}
  </div>
</fieldset>
```

样式要求：

- 4 个选项等宽。
- 当前选中态要明显区分。
- 未选中态保持和当前抽屉风格一致。
- 选项文案只显示：
  - `短`
  - `中`
  - `长`
  - `很长`
- 不显示数字副标题。

### 聚焦行为

抽屉打开后，仍保持现有行为：自动聚焦 textarea，而不是优先聚焦长度选择器。

原因：

- 长度偏好有稳定默认值和本地记忆。
- 用户打开抽屉后最常见动作仍然是继续输入续写指令。
- 保持当前 autofocus 行为可以减少现有交互变化。

## 页面集成方式

`StoryPage` 渲染抽屉时，建议这样传值：

```tsx
<StoryActionDrawer
  appendLengthSelector={
    activeDrawerMode === "append"
      ? {
          value: appendTargetLength,
          options: APPEND_TARGET_LENGTH_OPTIONS,
          onChange: handleAppendTargetLengthChange,
        }
      : undefined
  }
  ...
/>
```

效果：

- 打开 `append` 抽屉时显示长度选择器。
- 打开 `rewrite` / `dialogue` 抽屉时完全不显示该区域。
- `appendTargetLength` 状态继续保留在页面层，不受抽屉开关影响。

## 交互与状态细节

### 打开抽屉

- 打开 `append` 抽屉时，长度选择器显示当前用户最近一次选择的档位。
- 打开 `rewrite` 或 `dialogue` 抽屉时，不显示长度选择器，也不改动当前 `appendTargetLength`。

### 切换档位

- 点击后立即更新选中态。
- 立即写入 `localStorage`。
- 不清空当前 `appendInstruction` 草稿。
- 不关闭抽屉。

### 提交 append

- 仍使用现有 `生成续写` 按钮。
- 提交成功后抽屉关闭。
- `appendInstruction` 按现有逻辑在 completed 后清空。
- `appendTargetLength` 保持不变。

### 取消 / 失败

- 取消或失败后，不回滚到旧档位。
- 再次打开 `append` 抽屉时，仍显示用户最后一次选择的档位。

### 切换故事线

- 偏好为用户级，不是故事级。
- 从故事线 A 切到故事线 B，不重置 `appendTargetLength`。

### 切换用户

- 读取逻辑基于当前 `auth session` 的 `userId` 命名空间。
- 不同用户在同一浏览器中应看到各自的历史档位。

## 无障碍与可理解性

由于 UI 上只显示 `短 / 中 / 长 / 很长`，前端需要额外保证可理解性：

- 每个选项必须有 `assistiveText`，包含对应字数映射。
- 建议通过 `sr-only` 文本或 `aria-label` 暴露给辅助技术。
- 选择器容器需要有清晰分组标题，例如 `续写长度`。

这样可以兼顾：

- 视觉上更轻、更语义化
- 实现上仍能精确表达固定映射

## 涉及文件

### 新增

- `packages/web/src/pages/story/append-target-length-preference.ts`
- `docs/011/append-target-length-fe.md`

### 修改

- `packages/web/src/pages/story/StoryActionDrawer.tsx`
- `packages/web/src/pages/story/StoryPage.tsx`

### 无需直接修改

- `packages/web/src/story/storyRealtimeApi.ts`
  - 共享 payload 类型更新后，调用方按新 payload 传参即可。
- `packages/web/src/story/storylineApi.ts`
  - 本期前端长度能力不依赖新增 REST API。

## 测试与验证建议

当前 web 目录未见现成的页面级测试文件，本期建议先以类型检查、构建和手工验证为主。

### 命令验证

- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

### 手工验证

1. 进入已有故事线详情页，打开 `append` 抽屉，确认看到 4 个语义档位按钮。
2. 首次使用时，默认选中 `很长`。
3. 切换为 `短` 后刷新页面，再打开抽屉，仍为 `短`。
4. 切换到另一条故事线，再打开抽屉，仍为 `短`。
5. 发起 `append` 续写，确认 payload 带有正确的 `targetLength` 映射值。
6. 发起 `rewrite`，确认不展示长度选择器，且 payload 不带 `targetLength`。
7. 发起 `dialogue`，确认不展示长度选择器，且 payload 不带 `targetLength`。
8. 手动把对应 `localStorage` 值改成非法值，再刷新页面，确认静默回退到 `很长`，并覆盖坏值。
9. 切换到另一个登录用户，确认读取的是另一套本地偏好。

## 实施顺序建议

1. 先补共享 schema，确保 `StoryContinueAppendPayload` 已包含 `targetLength`。
2. 新增 `append-target-length-preference.ts`，固化本地 union、选项映射和存储读写。
3. 扩展 `StoryActionDrawer`，只在 `append` 模式渲染长度选择器。
4. 在 `StoryPage` 中接入 `appendTargetLength` 状态和 `handleAppendTargetLengthChange`。
5. 更新 `validatePayload` 的 `append` 分支，带上 `targetLength`。
6. 运行 `typecheck / lint / build`，再做手工验证。

## 风险与取舍

### 语义文案弱化了数字感知

只显示 `短 / 中 / 长 / 很长` 可以降低用户对严格字数的预期，但也牺牲了数字直观性。本方案通过固定映射、辅助技术文本和实现文档来弥补。

### `StoryPage` 状态继续膨胀

`StoryPage` 已经承担了较多页面状态。本期仍把 `appendTargetLength` 放在页面层，是为了避免把持久化逻辑塞进 `StoryActionDrawer`。代价是 `StoryPage` 会再多一个页面级 state。

### 本地偏好与登录态耦合

偏好 key 依赖当前登录用户的 `userId`。这能满足“用户级隔离”，但也意味着读取逻辑需要轻度依赖 `authApi` 的本地 session 结构。
