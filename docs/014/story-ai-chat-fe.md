# 当前章节「与 AI 聊聊」前端技术方案

## 文档范围

本文档对应产品需求：[story-ai-chat-prd.md](./story-ai-chat-prd.md)。

本期前端目标是在现有故事详情页中增加一套严格临时的章节聊天交互：

- 从 topbar「更多」菜单进入。
- 使用独立底部抽屉提交话题。
- 通过 HTTP NDJSON 接收 reasoning 和 answer 流。
- 按章节在页面内存中保存多个聊天块。
- 切章时保留聊天块，流式任务继续更新原章节。
- 不把聊天状态写入故事快照、浏览器存储或服务端任务。

本文档只描述 Web 前端与共享契约改动。服务端上下文选择、锁、Prompt 和不落盘实现见 [story-ai-chat-server.md](./story-ai-chat-server.md)。

## 现状

### 页面编排

故事详情页的主要编排集中在：

```text
packages/web/src/pages/story/StoryPage.tsx
```

当前 `StoryPage` 已负责：

- 故事窗口恢复和章节预取。
- 横向章节切换。
- 续写、重写和互动抽屉。
- WebSocket 正文生成。
- 后台生成任务轮询。
- 复制故事弹窗。
- 故事 reasoning 展示。
- 离开页面前的草稿确认。

聊天会增加一组独立的流式和分章节状态。不能把聊天伪装成新的 `GenerationIntent`，否则会错误触发：

- `StorylineSnapshot` 替换。
- context 更新阶段。
- 后台任务恢复。
- 正文临时页。
- 故事 reasoning 顶部面板。

### 阅读器与章节窗口

`StorylineReader` 当前只渲染当前章节。`StoryPage` 通过 `StorylineSnapshot.chapters` 保存一个有限窗口，并在翻页时调用：

```text
trimStorylineWindow(...)
mergeStorylineWindow(...)
```

因此聊天记录不能挂到 `StorylineChapter` 或 `StorylineSnapshot` 上。否则章节离开缓存窗口后，聊天记录会被裁剪掉；服务端刷新快照时也会覆盖本地聊天状态。

### 现有流式实现

项目有两种流式链路：

- 正式故事生成：WebSocket + 后台任务注册表。
- 设定补全：HTTP `fetch` + NDJSON + `AbortController`。

聊天严格临时、不支持断线恢复，也不能进入后台任务快照。前端应复用设定补全的 HTTP NDJSON 消费模式，而不是扩展 `storyRealtimeApi` 的后台生成语义。

### 现有抽屉

`StoryActionDrawer` 只服务：

```ts
type StoryActionKind = "append" | "rewrite" | "dialogue";
```

它的提交结果都是正式故事动作。聊天不属于 `StoryActionKind`，也没有续写长度、重写目标或互动输入语义，因此不扩展该 union，新增独立 `StoryChatDrawer`。

## 设计结论

- 新增独立 HTTP NDJSON API 客户端 `storyChatApi.ts`。
- 不修改现有 WebSocket `story.continue` 协议。
- 不把 chat 增加为 `StoryContinuePayload.mode`。
- 聊天记录和草稿由 `StoryPage` 按章节保存在 React state 中。
- 当前仅允许一个 active chat handle。
- 聊天记录不进入 `StorylineSnapshot`、URL、`localStorage` 或 `sessionStorage`。
- `StorylineReader` 只接收当前章节对应的聊天记录。
- 新增 `StoryChatDrawer`、`StoryChatBlock` 和 `StoryChatFloatingStatus`。
- 提交请求在收到 `started` 前保持抽屉打开；这样 `400/404/409` 可以原位提示并保留草稿。
- 收到 `started` 后才创建聊天块、清空草稿并关闭抽屉。
- reasoning 与 answer 都按提交时生成的 `chatId` 更新，不能依赖当前可见章节。
- 聊天 chunk 不触发自动滚动。
- active chat 时隐藏现有故事动作 FAB，展示独立固定停止控件。

## 文件改动

### 共享契约

```text
packages/schema/src/index.ts
```

新增：

- `StoryChapterChatRequestSchema`
- `StoryChapterChatStreamEventSchema`
- 对应 TypeScript 类型

### API 客户端

```text
packages/web/src/story/storyChatApi.ts
```

职责：

- 发起章节聊天请求。
- 消费 NDJSON。
- 校验事件 schema。
- 区分主动取消、静默关闭、鉴权失效和请求失败。
- 返回 `cancel / close` handle。

### 页面组件

```text
packages/web/src/pages/story/StoryChatDrawer.tsx
packages/web/src/pages/story/StoryChatBlock.tsx
packages/web/src/pages/story/StoryChatFloatingStatus.tsx
packages/web/src/pages/story/storyChatTypes.ts
```

### 现有组件

```text
packages/web/src/pages/story/StoryPage.tsx
packages/web/src/pages/story/StoryPageHeader.tsx
packages/web/src/pages/story/StorylineReader.tsx
```

不修改：

```text
packages/web/src/pages/story/StoryActionDrawer.tsx
packages/web/src/pages/story/StoryActionFab.tsx
packages/web/src/story/storyRealtimeApi.ts
packages/web/src/story/storyReasoningHandoff.ts
```

聊天不复用故事 reasoning handoff，因为刷新和路由跳转后必须丢失。

## 共享契约

### 请求

新增：

```ts
export const StoryChapterChatRequestSchema = z
  .object({
    chapterNumber: z.number().int().positive(),
    topic: z.string().trim().min(1).max(4_000),
  })
  .strict();

export type StoryChapterChatRequest = z.infer<
  typeof StoryChapterChatRequestSchema
>;
```

前端只发送章节号和话题：

```json
{
  "chapterNumber": 8,
  "topic": "这里让林夏立刻相信店主是否太突兀？"
}
```

不得发送：

- 章节正文。
- 历史章节。
- context。
- 当前聊天记录。
- 用户侧拼装 Prompt。

### NDJSON 事件

建议使用聊天专属事件，避免把普通 LLM `chunk` 与聊天 answer 语义混淆：

```ts
export const StoryChapterChatStartedEventSchema = z
  .object({
    type: z.literal("started"),
  })
  .strict();

export const StoryChapterChatReasoningChunkEventSchema = z
  .object({
    type: z.literal("reasoning_chunk"),
    sequence: z.number().int().positive(),
    delta: z.string().min(1),
  })
  .strict();

export const StoryChapterChatAnswerChunkEventSchema = z
  .object({
    type: z.literal("answer_chunk"),
    sequence: z.number().int().positive(),
    delta: z.string().min(1),
  })
  .strict();

export const StoryChapterChatCompletedEventSchema = z
  .object({
    type: z.literal("completed"),
  })
  .strict();

export const StoryChapterChatErrorCodeSchema = z.enum([
  "CHAT_FAILED",
  "LLM_EMPTY_RESPONSE",
]);

export const StoryChapterChatErrorEventSchema = z
  .object({
    type: z.literal("error"),
    code: StoryChapterChatErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const StoryChapterChatStreamEventSchema = z.discriminatedUnion("type", [
  StoryChapterChatStartedEventSchema,
  StoryChapterChatReasoningChunkEventSchema,
  StoryChapterChatAnswerChunkEventSchema,
  StoryChapterChatCompletedEventSchema,
  StoryChapterChatErrorEventSchema,
]);
```

`completed` 不返回模型、Token、故事快照或 segment ID。模型和 Token 只在服务端无内容日志中观测，页面不展示。

### HTTP 状态

在 NDJSON 响应开始前使用普通 HTTP 错误：

| 状态      | 前端语义                                          |
| --------- | ------------------------------------------------- |
| `400`     | 请求字段或章节号无效                              |
| `401`     | 登录失效，清理会话并跳转登录                      |
| `404`     | 故事或章节不存在                                  |
| `409`     | 故事正被生成、复制、提取 context 或另一次聊天占用 |
| `413`     | 完整安全 context 与最近 10 章超过聊天 Prompt 上限 |
| `500/502` | 准备聊天失败                                      |

响应进入 `200 application/x-ndjson` 后的失败使用 `error` 事件。

## API 客户端

### 接口

新增：

```ts
export interface StoryChapterChatCallbacks {
  onStarted(): void;
  onReasoningChunk(delta: string, sequence: number): void;
  onAnswerChunk(delta: string, sequence: number): void;
  onCompleted(): void;
  onCancelled(): void;
  onError(error: StoryChapterChatError): void;
  onAuthRequired(): void;
}

export interface StoryChapterChatHandle {
  cancel(): void;
  close(): void;
}

export function startStoryChapterChat(
  storylineId: StorylineId,
  request: StoryChapterChatRequest,
  callbacks: StoryChapterChatCallbacks,
): StoryChapterChatHandle;
```

错误结构：

```ts
export interface StoryChapterChatError {
  readonly code:
    | "INVALID_REQUEST"
    | "RESOURCE_NOT_FOUND"
    | "STORYLINE_BUSY"
    | "CHAT_CONTEXT_TOO_LARGE"
    | "LLM_EMPTY_RESPONSE"
    | "CHAT_FAILED"
    | "UNKNOWN";
  readonly message: string;
  readonly retryable: boolean;
}
```

### 请求地址

```text
POST /storylines/:storylineId/chat/stream
Accept: application/x-ndjson
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Handle 语义

`cancel()`：

- 表示用户主动停止。
- 调用 `AbortController.abort()`。
- 如果尚未 settle，最终回调 `onCancelled()`。
- 页面保留已创建聊天块和部分内容。

`close()`：

- 用于组件卸载、恢复其它故事或确认离开页面。
- 调用 `AbortController.abort()`。
- 不再触发任何 UI 回调。
- 不把正在离开的页面重新 setState。

### 流解析

实现可复用 `storySettingApi.ts` 的结构，但不直接导入其私有函数：

1. 获取 auth session。
2. 创建 `AbortController`。
3. `fetch` 请求。
4. 处理 `401` 和非 `2xx` JSON 错误。
5. 使用 `ReadableStreamDefaultReader` 读取字节。
6. `TextDecoder` 处理跨 chunk UTF-8。
7. 按换行分割 NDJSON。
8. 每行通过 `StoryChapterChatStreamEventSchema.safeParse`。
9. 协议错误按 `UNKNOWN` 失败。

建议把通用 NDJSON 分行逻辑抽到：

```text
packages/web/src/api/ndjson.ts
```

如果不希望在本期扩大改动面，也可以在 `storyChatApi.ts` 内保留一份小型实现；不要为了复用把聊天逻辑塞进 `storySettingApi.ts`。

### Sequence

reasoning 和 answer 使用独立 sequence：

```ts
let lastReasoningSequence = 0;
let lastAnswerSequence = 0;
```

每类事件都必须严格递增：

```text
nextSequence = previousSequence + 1
```

收到重复、跳号或倒序事件时：

- 中止 reader。
- 关闭请求。
- 以 `UNKNOWN` 标记当前聊天失败。
- 保留已收到内容。

HTTP 流本身有顺序保证，但显式检查可以尽早发现服务端协议回归。

### 终态

- 收到 `completed`：调用 `onCompleted`，取消 reader，settle。
- 收到 `error`：调用 `onError`，取消 reader，settle。
- 用户 abort：调用 `onCancelled`。
- 静默 close：不回调。
- 流在没有终态事件时结束：`UNKNOWN`。

## 前端状态

### 类型

新增：

```ts
export type StoryChatEntryStatus =
  | "connecting"
  | "thinking"
  | "answering"
  | "completed"
  | "cancelled"
  | "failed";

export interface StoryChatEntry {
  readonly id: string;
  readonly chapterNumber: number;
  readonly topic: string;
  readonly reasoningText: string;
  readonly answerText: string;
  readonly status: StoryChatEntryStatus;
  readonly isExpanded: boolean;
  readonly isReasoningExpanded: boolean;
  readonly errorMessage?: string | undefined;
}

export type StoryChatsByChapter = Readonly<
  Record<number, readonly StoryChatEntry[]>
>;

export type StoryChatDraftsByChapter = Readonly<Record<number, string>>;

export interface ActiveStoryChat {
  readonly chatId: string;
  readonly chapterNumber: number;
}
```

`chatId` 只用于当前页面内存定位，可使用：

```ts
crypto.randomUUID();
```

不发送服务端，也不写浏览器存储。

### StoryPage state

新增：

```ts
const chatHandleRef = useRef<StoryChapterChatHandle | null>(null);

const [chatDraftsByChapter, setChatDraftsByChapter] =
  useState<StoryChatDraftsByChapter>({});
const [chatsByChapter, setChatsByChapter] = useState<StoryChatsByChapter>({});
const [chatDrawerChapterNumber, setChatDrawerChapterNumber] = useState<
  number | null
>(null);
const [chatDrawerError, setChatDrawerError] = useState<string | undefined>();
const [isChatSubmitting, setIsChatSubmitting] = useState(false);
const [activeStoryChat, setActiveStoryChat] = useState<ActiveStoryChat | null>(
  null,
);
```

不要把 chat 状态加入 `StorylinePageStatus`。`StorylinePageStatus` 描述正式故事加载和生成状态；聊天可在用户切章时独立继续，使用单独状态更清晰。

### 不可变更新 helper

新增纯函数，避免在多个回调中复制嵌套 state 更新：

```ts
appendStoryChat(
  state: StoryChatsByChapter,
  entry: StoryChatEntry,
): StoryChatsByChapter

updateStoryChat(
  state: StoryChatsByChapter,
  chapterNumber: number,
  chatId: string,
  updater: (entry: StoryChatEntry) => StoryChatEntry,
): StoryChatsByChapter
```

若目标 `chatId` 不存在，helper 返回原 state。流式回调不得退化为“更新当前章节最后一条”，因为用户可以切章，且同章存在多个历史块。

### 状态转换

聊天块只在服务端发送 `started` 后创建：

```text
无记录
  -> started: connecting
  -> first reasoning: thinking
  -> first answer: answering
  -> completed: completed
  -> user abort: cancelled
  -> stream/error: failed
```

特殊情况：

- 没有 reasoning，first answer 直接从 `connecting` 进入 `answering`。
- reasoning 后无 answer 且收到空回答错误：`failed`。
- 取消时保留当前 status 已累积文本，但终态改为 `cancelled`。

### 展开状态

创建记录时：

```ts
isExpanded: true;
isReasoningExpanded: true;
```

reasoning 或 answer chunk 只修改文本和 status，不修改任何展开状态。

用户手动折叠后：

- 后续 reasoning 不自动展开思考区。
- 首个 answer 不自动折叠思考区。
- completed 不自动折叠外层块。

## 提交流程

### 打开抽屉

`StoryPageHeader` 点击「与 AI 聊聊」时：

1. 读取当前正式章节号 `readerPageIndex + 1`。
2. 校验该章节已存在于当前 `StorylineSnapshot` 窗口。
3. 校验不是临时 append 页。
4. 设置 `chatDrawerChapterNumber`。
5. 清空字段错误。
6. 打开 `StoryChatDrawer`。

打开时不创建聊天记录。

### 客户端校验

提交前：

```ts
const topic = draft.trim();
```

- 空字符串：`请输入想聊的话题`。
- 超过 4000：不发送请求。
- 故事或章节缺失：关闭抽屉并提示章节不可用。
- 已有 chat 或故事任务：不发送请求。

### 请求准备阶段

点击提交后：

- `isChatSubmitting = true`。
- 抽屉保持打开。
- textarea、关闭按钮和提交按钮禁用。
- 主按钮文案改为「正在准备...」。
- 保留草稿。

这样服务端在流开始前返回 `404/409` 时，可以原位展示错误，不产生空聊天块。

### 收到 started

在发起请求前生成并闭包捕获：

```ts
const chatId = crypto.randomUUID();
const chapterNumber = chatDrawerChapterNumber;
const submittedTopic = topic;
```

收到 `started` 后：

1. 在 `chatsByChapter[chapterNumber]` 末尾追加记录。
2. 设置 `activeStoryChat = { chatId, chapterNumber }`。
3. 清空该章草稿。
4. 清空抽屉错误。
5. `isChatSubmitting = false`。
6. 关闭抽屉。
7. 不调用 `scrollTo`。

### reasoning 回调

```ts
updateStoryChat(..., (entry) => ({
  ...entry,
  reasoningText: `${entry.reasoningText}${delta}`,
  status: entry.answerText.length > 0 ? "answering" : "thinking",
}));
```

### answer 回调

```ts
updateStoryChat(..., (entry) => ({
  ...entry,
  answerText: `${entry.answerText}${delta}`,
  status: "answering",
}));
```

不修改当前页、不切章、不滚动。

### completed

- 将目标记录设为 `completed`。
- 清空 `chatHandleRef`。
- 清空 `activeStoryChat`。
- 不修改故事快照。
- 不拉取故事详情。
- 不清理历史聊天块。

### started 前失败

如果 `onStarted` 尚未发生：

- 抽屉保持打开。
- `isChatSubmitting = false`。
- 保留草稿。
- 在抽屉内展示错误。
- 不创建聊天块。

### started 后失败

- 目标记录设为 `failed`。
- 保留 reasoning 和 answer。
- 写入可展示的 `errorMessage`。
- 清空 active handle。
- 使用 Toast 提示一次。

### 取消

固定停止按钮调用：

```ts
chatHandleRef.current?.cancel();
```

`onCancelled`：

- 目标记录设为 `cancelled`。
- 保留已有文本。
- 清空 active handle。
- 不回填话题草稿。
- 不滚动。

## 顶部菜单

### Props

`StoryPageHeaderProps` 新增：

```ts
readonly isChatDisabled: boolean;
readonly chatDisabledReason?: string | undefined;
readonly onOpenChat: () => void;
```

菜单顺序：

```text
与 AI 聊聊
复制故事
上下文
```

聊天项始终渲染。禁用时：

- `disabled=true`
- `title={chatDisabledReason}`
- 样式与复制故事禁用态一致

建议把菜单项重复 class 提取成局部常量或小组件，但不需要为三个按钮建设通用菜单框架。

### 禁用计算

```ts
const isChatBusy = isChatSubmitting || activeStoryChat !== null;

const isChatDisabled =
  storyline === null ||
  chapterLoadStatus !== "idle" ||
  isGenerating ||
  isCopySubmitting ||
  isChatBusy ||
  currentReaderPageNumber === null ||
  currentReaderPageNumber > storyline.chapterCount ||
  findStorylineChapter(storyline, currentReaderPageNumber) === undefined;
```

其它标签页或 context 页面产生的服务端锁无法仅靠前端判断，最终以 `409` 为准。

## 聊天抽屉

新增 `StoryChatDrawer.tsx`，结构沿用 `StoryActionDrawer` 的遮罩、定位和 safe-area 样式，但保持独立 props：

```ts
interface StoryChatDrawerProps {
  readonly chapterNumber: number;
  readonly error?: string | undefined;
  readonly isSubmitting: boolean;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly value: string;
}
```

文案：

```text
标题：与 AI 聊聊
辅助信息：正在讨论第 N 章
字段：想聊的话题
占位：可以讨论情节、人物、伏笔、续写方向，或询问任何与当前故事有关的问题
按钮：发送给 AI
提交中：正在准备...
```

textarea：

```tsx
maxLength={4_000}
```

交互：

- 打开后 requestAnimationFrame 聚焦。
- 空闲时点击遮罩、关闭按钮或 Escape 只关闭抽屉，保留该章草稿。
- `isSubmitting` 时禁用关闭、遮罩关闭、Escape、textarea 和主按钮。
- 字段变化时清空抽屉错误。

## 聊天块

### Props

```ts
interface StoryChatBlockProps {
  readonly entry: StoryChatEntry;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onReasoningExpandedChange: (expanded: boolean) => void;
}
```

组件不直接持有流式 state，避免章节卸载再挂载时丢失折叠状态。

### 结构

```text
section
  header button: 与 AI 聊聊 + 状态 + 展开/收起
  expanded content
    section: 你想聊的
    section: AI 的思考
      button: 展开/收起
      reasoning text
    section: AI 的回答
      answer text / 等待提示
    terminal error message
```

外层与思考区使用不同 `useId()`，分别设置：

- `aria-controls`
- `aria-expanded`
- `role="region"`

### 状态文案

| 状态         | 文案     |
| ------------ | -------- |
| `connecting` | 正在连接 |
| `thinking`   | 正在思考 |
| `answering`  | 正在回答 |
| `completed`  | 已完成   |
| `cancelled`  | 已取消   |
| `failed`     | 生成失败 |

### 空内容

- reasoning 为空：不渲染思考区。
- answer 为空且未结束：展示「正在等待回答...」。
- answer 为空且 cancelled：不添加虚构占位正文。
- answer 为空且 failed：展示错误状态。

正文使用：

```tsx
className = "whitespace-pre-wrap break-words";
```

React 文本节点天然转义 HTML，不使用 `dangerouslySetInnerHTML`。

## 阅读器接入

### StorylineReader Props

新增：

```ts
readonly chatEntries: readonly StoryChatEntry[];
readonly onChatExpandedChange: (
  chatId: string,
  expanded: boolean,
) => void;
readonly onChatReasoningExpandedChange: (
  chatId: string,
  expanded: boolean,
) => void;
```

`StoryPage` 根据当前正式章节号传入：

```ts
const currentChapterChatEntries =
  currentReaderPageNumber === null
    ? []
    : (chatsByChapter[currentReaderPageNumber] ?? []);
```

提交预览和临时 append 页传空数组。

### 渲染顺序

`StorylinePagePanel` 中：

1. 主正文。
2. 初始续写指令，仅现有 create preview。
3. 重写临时块，仅正式生成场景。
4. 正式 dialogue。
5. 章节聊天块。
6. 临时 dialogue，仅正式生成场景。

聊天与正式生成互斥，因此正常情况下聊天块不会与重写或临时 dialogue 同时变化。仍保持确定顺序，避免异常恢复时 JSX 位置不稳定。

### 章节缓存

`chatsByChapter` 独立于：

- `trimStorylineWindow`
- `mergeStorylineWindow`
- `restoreStorylineSnapshot`

翻到缓存外章节时：

- 服务端只重新加载故事章节。
- 对应 `chatsByChapter[pageNumber]` 仍在。
- 章节重新进入窗口后恢复聊天块。

切换到其它故事或调用完整 `restoreStoryline()` 初始化新路由时，显式清空 chat state。

## 固定流式状态

新增 `StoryChatFloatingStatus.tsx`：

```ts
interface StoryChatFloatingStatusProps {
  readonly chapterNumber: number;
  readonly hasBottomBar: boolean;
  readonly onCancel: () => void;
}
```

展示：

- 紧凑标签：「第 N 章 AI 回答中」
- `CircleStop` 按钮
- `aria-label="停止 AI 回答"`

定位沿用 `StoryActionFab`：

```text
有分页栏：bottom-[calc(5rem+env(safe-area-inset-bottom))]
无分页栏：bottom-[calc(1rem+env(safe-area-inset-bottom))]
```

显示优先级：

```text
active chat > story action FAB
```

`activeStoryChat !== null` 时：

- 渲染 `StoryChatFloatingStatus`。
- 不渲染 `StoryActionFab`。
- 不因当前可见页不是目标页而隐藏。

正式故事生成期间本来就不能启动 chat，因此不会出现两个停止按钮。

## 滚动行为

聊天必须避免以下调用：

```ts
contentScrollRef.current?.scrollTo(...)
scrollIntoView(...)
```

以下事件都不自动滚动：

- started。
- reasoning chunk。
- answer chunk。
- completed。
- cancelled。
- failed。

章节切换仍保留现有滚到章节顶部行为。这是用户主动翻页，不属于聊天自动滚动。

如果用户正在目标章节底部阅读，DOM 增长可以自然保留当前位置；本期不为聊天新增 near-bottom 跟随 effect。

## 与正式故事动作的互斥

新增页面级派生值：

```ts
const isChatBusy = isChatSubmitting || activeStoryChat !== null;
```

`isChatBusy` 时：

- 禁用 topbar 的聊天与复制。
- 不允许 `handleSelectStoryAction` 打开续写、重写或互动抽屉。
- 隐藏故事动作 FAB。
- 不允许打开 context 页面，或先弹出离开确认。
- 不影响章节上一页/下一页。

`isGenerating || isCopySubmitting` 时禁止打开聊天。

服务端 `409` 仍是并发真相来源。前端互斥只减少当前页面内的误操作。

## 离开与清理

### 路由内离开

active chat 时点击：

- 返回故事列表。
- 打开 context。
- 跳转其它故事。

弹出：

```text
AI 正在回答，离开会取消回答并丢失本页聊天记录。确定离开吗？
```

确认后：

```ts
chatHandleRef.current?.close();
chatHandleRef.current = null;
```

随后导航。因为页面即将卸载，不需要把记录先标成 cancelled。

已完成、已取消或失败的聊天不阻止离开。

### 未提交草稿

扩展 `hasUnsavedDraft`，加入：

```ts
Object.values(chatDraftsByChapter).some((draft) => draft.trim().length > 0);
```

active chat 确认优先于普通草稿确认，避免连续弹两个确认框。

### 浏览器刷新或关闭

active chat 时注册 `beforeunload`：

```ts
useEffect(() => {
  if (activeStoryChat === null && !isChatSubmitting) {
    return undefined;
  }

  const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = "";
  };

  window.addEventListener("beforeunload", handleBeforeUnload);
  return () => window.removeEventListener("beforeunload", handleBeforeUnload);
}, [activeStoryChat, isChatSubmitting]);
```

浏览器只会展示统一提示文案。

### 组件卸载

StoryPage 现有 cleanup 中增加：

```ts
chatHandleRef.current?.close();
chatHandleRef.current = null;
```

`restoreStoryline()` 开始时也执行相同清理，并重置：

```ts
setChatDraftsByChapter({});
setChatsByChapter({});
setChatDrawerChapterNumber(null);
setChatDrawerError(undefined);
setIsChatSubmitting(false);
setActiveStoryChat(null);
```

## 错误映射

建议文案：

| 错误                 | 文案                                 |
| -------------------- | ------------------------------------ |
| 空输入               | 请输入想聊的话题                     |
| `400`                | 当前输入或章节不可用，请检查后重试   |
| `404`                | 故事或当前章节不可用，请刷新后重试   |
| `409`                | 当前故事正在处理中，请稍后重试       |
| `413`                | 当前故事材料过长，暂时无法与 AI 聊聊 |
| `LLM_EMPTY_RESPONSE` | AI 没有返回回答，请重新提问          |
| 其它流式错误         | AI 回答失败，请稍后重试              |
| 网络错误             | 网络连接失败，请稍后重试             |

started 前错误显示在抽屉中；started 后错误写入聊天块并额外 Toast 一次。

不要把服务端原始异常、Prompt 或 context 内容展示给用户。

## 可访问性

- topbar 入口保持 `role="menuitem"`。
- 禁用入口有 `disabled` 和原因 `title`。
- 抽屉打开后聚焦 textarea。
- 抽屉错误通过 `aria-describedby` 和 `role="alert"` 关联。
- 外层聊天块与思考区各自维护折叠 ARIA。
- 状态区域使用 `role="status"`，但不逐 chunk 使用 assertive live region。
- 固定停止按钮具有明确中文 aria-label。
- 状态不能只依赖颜色。

## 测试方案

当前 Web 包和 Schema 包都没有独立单元测试脚本，本期不为此功能引入新的测试框架。前端验证分为服务端 Jest 中的共享 schema 用例、构建检查和浏览器手测。

### 共享 schema

在服务端 `storyline-chat.controller.spec.ts` 或独立 schema spec 中直接导入 `@kimiko/schema` 覆盖：

- request 接受合法章节号和 1-4000 字符话题。
- 空话题、4001 字符、非整数章节号失败。
- started、reasoning、answer、completed、error 事件通过。
- delta 为空、sequence 非正整数、未知字段失败。

### 构建检查

```bash
pnpm --filter @kimiko/schema build
pnpm --filter @kimiko/web typecheck
pnpm --filter @kimiko/web build
```

### 浏览器手测

入口与抽屉：

- 任意正式章节均可打开。
- 临时页和故事忙碌时禁用。
- 每章草稿独立。
- 空输入和 4000 字符边界正确。
- started 前 `409` 保留抽屉和草稿。

流式：

- reasoning 与 answer 分区追加。
- 两个折叠区默认展开。
- 手动折叠后 chunk 不改变选择。
- 提交和 chunk 不改变滚动位置。
- 取消和失败保留部分内容。

章节：

- 第 8 章发起后切到第 9 章，任务继续。
- 固定停止控件仍显示第 8 章。
- 返回第 8 章看到完整流式结果。
- 聊天章节离开缓存窗口再返回，记录仍存在。

生命周期：

- 同章多次提交按顺序保留。
- 第二次请求不携带第一次内容。
- 刷新、返回列表和打开其它故事后记录清空。
- active chat 离开页面有确认。

互斥：

- chat 中 FAB 不出现，复制和 context 入口不可执行。
- story generation 中 chat 入口不可用。
- 多标签页竞争收到 `409` 后 UI 可恢复。

## 实施顺序

1. 扩展 `@kimiko/schema` 聊天请求和 NDJSON 事件。
2. 新增 `storyChatApi.ts`，完成取消、关闭和错误分流。
3. 新增 `storyChatTypes.ts` 与不可变更新 helper。
4. 新增 `StoryChatDrawer`。
5. 新增 `StoryChatBlock`。
6. 扩展 `StorylineReader` 渲染当前章聊天块。
7. 扩展 `StoryPageHeader` 菜单入口和禁用原因。
8. 在 `StoryPage` 接入草稿、聊天记录、active handle 和流回调。
9. 新增 `StoryChatFloatingStatus` 并处理 FAB 优先级。
10. 接入离开确认、beforeunload 和 restore cleanup。
11. 执行 schema、Web 构建和浏览器手测。

## 风险

### StoryPage 继续膨胀

`StoryPage` 已承担较多编排。本期至少应把：

- NDJSON API。
- 聊天块。
- 聊天抽屉。
- 固定状态。
- state helper。

拆出独立文件。首版可以继续由 `StoryPage` 持有状态，不建议在本期引入全局 store。

### 回调误写当前章节

流式期间用户可以翻页。任何基于 `readerPageIndexRef.current` 更新聊天内容的实现都是错误的。

所有回调必须闭包捕获提交时的：

```text
chapterNumber + chatId
```

### 章节窗口覆盖本地状态

服务端快照恢复会替换 `storyline`。聊天必须保存在独立 state，不能扩展 schema 中的 `StorylineChapter`。

### started 前后的错误分流

若提交后立即关闭抽屉并创建块，`409` 会留下错误空块，与 PRD 不符。必须等服务端完成鉴权、锁和章节校验并发送 `started` 后，再将请求转成聊天块。

### 静默 close 触发脏回调

路由离开时使用 `close()` 而非 `cancel()`。API 客户端必须通过 `isClosedByClient` 阻止卸载后的回调。
