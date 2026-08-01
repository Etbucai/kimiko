# 故事上下文输出 Token 优化服务端技术方案

## 背景

本文档对应 `009` 主题：降低故事上下文压缩阶段的 LLM output token。

`008` 已经把旧 summary 升级为结构化 `StoryContextSnapshot`，并在每轮正文生成完成后调用 context extractor 更新上下文。当前实现的问题是：extractor 输出的是完整 `StoryContextDraftSnapshot`，服务端再把 draft 归一化为最终 `StoryContextSnapshot` 落库。

这让“上下文压缩”在实际运行中变成了“全量重写上下文 JSON”。随着故事线变长，旧事实、旧角色认知和来源引用会在每轮输出中反复出现，导致 output token、耗时和失败概率快速上升。

## 样本诊断

基于 `/log` 中两次 `text-completed` LLM 调用文件：

| 调用              | 性质                                 | inputTokens | outputTokens | 输出字符 |   耗时 |
| ----------------- | ------------------------------------ | ----------: | -----------: | -------: | -----: |
| 首次 context 生成 | `StoryContextDraftSnapshot` 全量输出 |        7238 |        10372 |     9634 | 147.9s |
| repair 调用       | 修复同一份 JSON                      |        4038 |         5291 |     9684 |  59.8s |

关键观察：

- 第二次不是独立上下文压缩，而是 repair。
- repair 只修复了一个缺失字段，但重新输出了完整 9.6K 字符 JSON。
- 首次输出中旧 context 已有 `18` 个 world facts 和 `2` 个 characters；输出仍把这批旧内容全部带回。
- 输出后 context 只有 `26` 个 world facts、`2` 个 characters、`7` 条 beliefs、`4` 条 relationships 和 `6` 条 opinions，真正语义文本约 1.5K 字符。
- 结构和格式开销很大：pretty JSON 的空白约 3K 字符，`sourceRefs` 出现 46 次。

结论：主要瓶颈不是 context 内容本身，而是当前内部 Interface 要求 LLM 每次输出完整快照。

## 目标

- 将 append / dialogue / rewrite 的 context extractor output token 显著降低。
- 保持持久化和前端调试契约不变：数据库仍保存最终 `StoryContextSnapshot`。
- 保持正文 segment 与 context 更新的事务原子性。
- 保持角色行动限制规则不变：writer prompt 仍只消费当前可观察事实和活跃角色认知。
- 保留当前 LLM 调用文件日志，用于度量优化效果。

## 非目标

- 不新增前端能力。
- 不拆分 context 到多张数据库表。
- 不引入长期异步任务队列。
- 不把 context extractor 失败降级为“正文先落库，context 后补”。
- 不追求一次性解决实体消歧、长期事实过期和复杂世界模拟。

## 已确认的五个优先级问题

### P1：Context 输出必须从全量快照改为增量 patch

当前 extractor 输出完整 `StoryContextDraftSnapshot`。这使旧 facts、旧 characters、旧 beliefs 每轮反复输出。

新的内部 Interface 应改为 `StoryContextPatchDraft`：

- LLM 只输出本轮新增事实。
- LLM 只输出本轮发生变化的角色字段。
- LLM 必须输出新的 `currentScene`，因为当前场景是下一轮生成的关键入口且体积较小。
- 服务端负责把 patch 应用到旧 `StoryContextSnapshot`，生成最终完整 snapshot。

### P2：Repair 不能全量重写

当前 repair 对完整 draft 做一次 LLM 修复，导致一次小错误额外消耗 5K+ output token。

新的 repair 策略：

- 先做本地容错修复。
- 只有 JSON 结构无法解析或本地修复后仍无法通过 schema 时，才调用 LLM repair。
- LLM repair 修复的是 patch，而不是完整 snapshot。
- repair prompt 要求输出 minified patch JSON。

### P3：输入和输出都必须是 minified JSON

当前 pretty JSON 空白约占输出字符的 32%。

新的 prompt 必须明确：

```text
只输出单行 JSON，不要换行，不要缩进，不要多余空格。
```

同时，服务端注入 prompt 的结构化 JSON 也必须 minified：

- 旧 `StoryContextSnapshot` 使用 `JSON.stringify(value)`，不使用 pretty print。
- schema 示例使用单行 JSON。
- repair prompt 中的待修复 JSON 保持原始输出；如果原始输出可解析，repair 前优先本地修复，不再进入 LLM repair。

服务端仍按 JSON 解析，不依赖格式化。

### P4：Schema 和预算要收紧

当前上限偏大，且 prompt 倾向让模型补全所有旧内容。

新的 patch 预算应按“每轮变化”控制：

- 每轮新增 facts 上限。
- 每轮更新 facts 上限。
- 每轮新增 characters 上限。
- 每轮更新 characters 上限。
- 每个角色新增 beliefs / opinions / relationships / actionTendencies 上限。
- 当前场景可观察 facts 上限。

服务端 apply patch 后还需要执行确定性裁剪，避免最终 snapshot 长期膨胀。

### P5：减少 provenance 重复

当前每个 fact、belief、opinion、relationship 都显式输出 `sourceRefs`，重复明显。

新的 patch draft 引入 `defaultSourceRefs`：

- patch 顶层声明默认来源，通常为 `["current"]`。
- 单个 item 没有 `sourceRefs` 时继承默认来源。
- 只有引用历史 segment 或多个来源时才显式写 `sourceRefs`。
- 最终落库仍写入 `sourceSegmentIds`，不改变外部契约。

## 设计总览

### Module 和 Seam

本期要把“LLM 输出完整 context”这个浅 Interface 改成更深的 Module。

新增或重塑的核心 Module：

```text
StorylineContextService
  Interface:
    generateStoryContextPatch(input, options): Promise<StoryContextPatchDraft>

StoryContextPatchApplier
  Interface:
    applyStoryContextPatch(input): StoryContextSnapshot

StoryContextPatchRepair
  Interface:
    parseAndRepairStoryContextPatch(rawText, context): StoryContextPatchDraft
```

Seam 放在 `StorylineService.save*WithContext` 内部的保存事务之前：

1. `StorylineGenerationService` 生成正文。
2. `StorylineContextService` 调 LLM 得到 patch draft。
3. `StorylineService.save*WithContext` 插入或更新 generated segment。
4. `StoryContextPatchApplier` 拿到新 segment ID 后把 patch 转为最终 `StoryContextSnapshot`。
5. 同一事务内保存 segment 和 context。

这样 caller 仍只知道“本轮生成需要一个 context draft”，复杂的 ID 复用、source 映射、预算裁剪和容错都藏在服务端内部 Implementation。

## 内部 Patch 契约

`StoryContextPatchDraft` 是服务端内部 schema，不暴露给前端。

建议结构：

```ts
export const StoryContextPatchDraftSchema = z
  .object({
    defaultSourceRefs: z
      .array(SourceRefSchema)
      .min(1)
      .max(4)
      .default(["current"]),
    worldFacts: z
      .object({
        add: z.array(StoryWorldFactCreateDraftSchema).max(8),
        update: z.array(StoryWorldFactUpdateDraftSchema).max(6),
        resolve: z.array(DraftRefSchema).max(6),
      })
      .strict(),
    characters: z
      .object({
        add: z.array(StoryCharacterCreateDraftSchema).max(2),
        update: z.array(StoryCharacterPatchDraftSchema).max(4),
      })
      .strict(),
    currentScene: StoryCurrentScenePatchDraftSchema,
  })
  .strict();
```

### `StoryWorldFactCreateDraft`

```ts
{
  draftKey: string;
  kind: "event" | "setting" | "environment" | "relationship" | "status" | "term";
  text: string;
  status?: "active" | "resolved";
  visibility?: "observable" | "public" | "hidden";
  sourceRefs?: string[];
}
```

默认值：

- `status` 默认 `"active"`。
- `visibility` 默认 `"observable"`。
- `sourceRefs` 缺失时继承 `defaultSourceRefs`。

### `StoryWorldFactUpdateDraft`

```ts
{
  existingId: "fact_N";
  text?: string;
  status?: "active" | "resolved";
  visibility?: "observable" | "public" | "hidden";
  sourceRefs?: string[];
}
```

规则：

- 只输出真实变化字段。
- 不允许只为重复旧信息而 update。
- `resolve` 是 `status: "resolved"` 的短写。

### `StoryCharacterCreateDraft`

新增角色仍需要完整身份信息，但只用于本轮真正首次出现的角色。

```ts
{
  draftKey: string;
  name: string;
  aliases?: string[];
  identity?: string;
  traits?: string[];
  motivations?: string[];
  currentStatus?: string;
  relationshipsAdded?: StoryCharacterRelationshipDraft[];
  beliefsAdded?: StoryCharacterBeliefDraft[];
  opinionsAdded?: StoryCharacterOpinionDraft[];
  actionTendenciesAdded?: string[];
  sourceRefs?: string[];
}
```

### `StoryCharacterPatchDraft`

已有角色只输出变化：

```ts
{
  existingId: "char_N";
  aliasesAdded?: string[];
  traitsAdded?: string[];
  motivationsAdded?: string[];
  currentStatus?: string;
  relationshipsAdded?: StoryCharacterRelationshipDraft[];
  beliefsAdded?: StoryCharacterBeliefDraft[];
  opinionsAdded?: StoryCharacterOpinionDraft[];
  actionTendenciesAdded?: string[];
  sourceRefs?: string[];
}
```

第一期不要求 LLM 删除旧 beliefs / opinions / relationships。长期膨胀由服务端预算裁剪解决。

### `StoryCurrentScenePatchDraft`

当前场景每轮直接替换，体积小且语义关键。

```ts
{
  location?: string;
  timeLabel?: string;
  presentCharacterRefs: string[];
  observableFactRefs: string[];
  sceneStatus?: string;
  sourceRefs?: string[];
}
```

字段默认：

- `location` / `timeLabel` / `sceneStatus` 缺失时继承旧 scene。
- `presentCharacterRefs` 和 `observableFactRefs` 缺失时本地修复为空数组；prompt 仍要求输出。
- `sourceRefs` 缺失时继承 `defaultSourceRefs`。

## Patch Apply 规则

新增 `storyline-context-patch.ts`，提供：

```ts
export function applyStoryContextPatch(
  input: ApplyStoryContextPatchInput,
): StoryContextSnapshot;
```

输入：

```ts
interface ApplyStoryContextPatchInput {
  readonly previousContext: StoryContextSnapshot | null;
  readonly patch: StoryContextPatchDraft;
  readonly sourceRefToSegmentId: ReadonlyMap<string, string>;
}
```

应用顺序：

1. 以 `previousContext ?? emptyStoryContextSnapshot` 作为 base。
2. 建立角色 ref map：
   - 旧 `char_N`。
   - 本轮新增 `draftKey`。
   - 仍保留 name / aliases 强匹配，避免重复角色。
3. 建立事实 ref map：
   - 旧 `fact_N`。
   - 本轮新增 `draftKey`。
   - 仍按 `kind + normalized text` 强匹配，避免重复事实。
4. 应用 `worldFacts.add`。
5. 应用 `worldFacts.update` 和 `worldFacts.resolve`。
6. 应用 `characters.add`。
7. 应用 `characters.update`：
   - `currentStatus` 替换。
   - `aliasesAdded` / `traitsAdded` / `motivationsAdded` / `actionTendenciesAdded` 去重追加。
   - `relationshipsAdded` / `beliefsAdded` / `opinionsAdded` 解析 refs 后追加。
8. 替换 `currentScene`。
9. 执行预算裁剪。
10. 用 `StoryContextSnapshotSchema` 校验最终 snapshot。

## 本地 Repair 规则

新增 `storyline-context-patch-repair.ts` 或放入 patch parser 内部。

本地修复只处理确定性、无语义风险的问题：

- 缺失数组字段：
  - `add` / `update` / `resolve` 缺失时补 `[]`。
  - `aliasesAdded` / `traitsAdded` 等缺失时补 `[]` 或保持 `undefined`。
  - `factRefs` 缺失时补 `[]`。
- 枚举值异常：
  - 非法 `truthStatus` 改为 `"unknown"`。
  - 非法 `status` 改为 `"active"`。
  - 非法 `visibility` 改为 `"observable"`。
- `sourceRefs`：
  - 缺失时继承 `defaultSourceRefs`。
  - 包含未知 source ref 时过滤。
  - 过滤后为空则使用 `["current"]`，但只有当 `current` 是合法 source 时才这样做。
- refs：
  - `factRefs` 中未知引用过滤。
  - `presentCharacterRefs` / `observableFactRefs` 中未知引用过滤，避免整轮失败。

只有以下情况才进入 LLM repair：

- JSON 无法解析。
- 本地修复后 patch schema 仍失败。
- apply 后最终 `StoryContextSnapshotSchema` 仍失败。

LLM repair 仍只允许 1 次，并且修复对象是 patch，不是完整 snapshot。

## Prompt 变更

### Context Patch Prompt

系统提示词改为：

```text
你是 StoryAgent 的故事上下文增量维护器。
你只输出本轮相对旧故事上下文的增量 patch。
不要重复输出旧 context 中未变化的事实、角色、认知或关系。
你必须只输出单行 JSON，不要换行，不要缩进，不要解释。
```

用户 prompt 保留：

- 旧 context。
- 可用 source refs。
- 初始正文或近期 history。
- 本轮指令。
- 本轮生成正文。

新增硬约束：

```text
输入中的旧故事上下文和 schema 示例均为 minified JSON。
如果旧 context 中的条目没有变化，不要输出它。
已有事实只在 text/status/visibility 发生变化时放入 worldFacts.update。
已有角色只在 currentStatus 或新增认知发生变化时放入 characters.update。
本轮新增事实最多 8 条。
每个角色本轮新增 beliefs 最多 4 条，opinions 最多 3 条，relationships 最多 2 条。
sourceRefs 缺省时继承 defaultSourceRefs。
```

### Repair Prompt

repair prompt 改为：

```text
你是 StoryAgent 的 context patch JSON 修复器。
你只能修复这份 patch JSON，使其符合 StoryContextPatchDraft schema。
不要输出完整 StoryContextSnapshot。
不要补充新事实。
只输出单行 JSON。
```

## 预算裁剪策略

新增 `STORY_CONTEXT_PATCH_LIMITS`：

```ts
export const STORY_CONTEXT_PATCH_LIMITS = {
  factsAddedPerTurn: 8,
  factsUpdatedPerTurn: 6,
  charactersAddedPerTurn: 2,
  charactersUpdatedPerTurn: 4,
  beliefsAddedPerCharacter: 4,
  opinionsAddedPerCharacter: 3,
  relationshipsAddedPerCharacter: 2,
  actionTendenciesAddedPerCharacter: 2,
  currentSceneObservableFacts: 12,
} as const;
```

最终 snapshot 仍保留 `STORY_CONTEXT_LIMITS`，但建议收紧：

- `worldFacts`: 从 80 降到 50。
- `characterBeliefs`: 从 30 降到 12。
- `characterOpinions`: 从 20 降到 8。
- `characterRelationships`: 从 30 降到 12。
- `characterActionTendencies`: 从 12 降到 8。

裁剪优先级：

1. 保留 `currentScene.observableFactIds` 指向的 facts。
2. 保留 active / observable / public facts。
3. 保留最近 source segment 的 facts。
4. 优先裁掉 resolved 且不在当前场景的旧 facts。
5. 角色 beliefs / opinions 按最近 source + 是否与当前 scene 相关排序。

## SourceRefs 优化

Patch draft 顶层新增：

```ts
defaultSourceRefs: ["current"];
```

服务端解析 item source：

```ts
function resolvePatchSourceRefs(
  itemSourceRefs: readonly string[] | undefined,
  defaultSourceRefs: readonly string[],
): string[] {
  return itemSourceRefs === undefined || itemSourceRefs.length === 0
    ? [...defaultSourceRefs]
    : [...itemSourceRefs];
}
```

最终 `StoryContextSnapshot` 仍保存 `sourceSegmentIds`，不改变前端调试页和数据库结构。

## 持久化影响

不需要数据库迁移。

保持不变：

- `storyline_context.context_json` 仍保存完整 `StoryContextSnapshot`。
- `storyline_segment.previous_context_json` 仍保存生成前的完整 context，用于 rewrite 回滚。
- 正文 segment 与 context 更新仍在同一事务内。

变化点：

- 保存方法的入参从 `contextDraft` 语义上变为 `contextPatch`。
- 可以先保留字段名 `contextDraft` 降低改动面，但实现文档和后续重命名建议改为 `contextPatch`。

## 文件调整

建议新增：

- `packages/server/src/storyline/storyline-context-patch.types.ts`
  - `StoryContextPatchDraftSchema`
  - patch 子 schema
  - `STORY_CONTEXT_PATCH_LIMITS`
- `packages/server/src/storyline/storyline-context-patch.ts`
  - `applyStoryContextPatch`
  - ID/ref/source 映射
  - merge 和预算裁剪
- `packages/server/src/storyline/storyline-context-patch-repair.ts`
  - 本地容错 repair
  - issue 分类

建议调整：

- `packages/server/src/storyline/storyline-context.service.ts`
  - `buildStoryContextLlmRequest` 改为 patch prompt。
  - `parseStoryContextDraftResponse` 替换为 `parseStoryContextPatchResponse`。
  - repair prompt 改成 patch repair。
- `packages/server/src/storyline/storyline.service.ts`
  - `normalizeStoryContextDraft` 替换为 `applyStoryContextPatch`。
- `packages/server/src/storyline/storyline.types.ts`
  - `contextDraft` 类型替换为 `StoryContextPatchDraft`。
- `packages/server/src/storyline/storyline-generation.service.ts`
  - 变量名从 `contextDraft` 改为 `contextPatch`。
- `packages/server/src/storyline/storyline-context-normalize.ts`
  - 可保留一段时间供迁移对照，最终删除或只保留 `serializeStoryContext` / `parseStoryContextJson`。

## 兼容策略

项目是本地实验性质，不考虑旧版本兼容。

但为了降低实施风险，建议代码层分两步：

1. 先新增 `applyStoryContextPatch` 和 patch schema，保留旧 `normalizeStoryContextDraft`。
2. 替换 `StorylineContextService` 输出和保存链路后，删除旧 draft snapshot schema。

## 测试计划

### 单元测试

新增 `storyline-context-patch.spec.ts`：

- 空 context + add patch -> 生成初始 snapshot。
- 旧 context + add facts -> 只新增 facts，旧 facts 保留。
- 旧 context + update fact -> 只更新目标 fact。
- 旧 context + update character -> 追加 beliefs / opinions / relationships。
- `defaultSourceRefs` 生效。
- source ref 映射到真实 segment ID。
- 未知 refs 被本地 repair 过滤或失败。
- 预算裁剪保留 currentScene facts。

新增 `storyline-context-patch-repair.spec.ts`：

- 缺失 `factRefs` 补 `[]`。
- 非法 `truthStatus` 改 `"unknown"`。
- 缺失 `sourceRefs` 继承默认来源。
- pretty JSON / minified JSON 都可解析。

调整 `storyline-context.service.spec.ts`：

- prompt 要求增量 patch，不允许完整 snapshot。
- repair 只输出 patch。
- repair 失败仍抛 `StoryContextFailedError`。

调整 `storyline.service.spec.ts`：

- segment 与 patch apply 后的 context 同事务保存。
- `previousContextJson` 仍保存生成前 snapshot。
- rewrite 仍从目标段 `previousContextJson` 开始 apply patch。

### 回归验证

保留 LLM 调用文件日志，用真实运行验证：

- append 的 context `outputTokens` 应从 5K-10K 级别下降到 1K-2K 以内。
- repair 的 `outputTokens` 应下降到 500-1000 以内。
- `response.textChars` 不应接近最终 `context_json` 的完整大小。
- `text-completed` 文件中不应再出现完整旧 worldFacts 列表。

## 验收标准

- 每轮 context extractor 输出为 `StoryContextPatchDraft`，不再输出完整 `StoryContextDraftSnapshot`。
- 普通 append 中，旧 facts / characters 未变化时不会出现在 LLM 输出里。
- repair 不会要求模型重写完整 snapshot。
- Context LLM prompt 明确要求 minified JSON。
- `storyline_context.context_json` 仍保存完整最终 snapshot。
- `previousContextJson` 回滚机制不变。
- 服务端 typecheck、lint、单元测试通过。

## 实施顺序

1. 新增 patch draft schema 和 patch apply Module。
2. 补本地 repair Module。
3. 改 `StorylineContextService` prompt 和 parse 流程。
4. 改保存链路，把 `normalizeStoryContextDraft` 替换为 `applyStoryContextPatch`。
5. 更新变量命名和类型。
6. 删除旧 full draft schema。
7. 用 `/log` 文件对比真实 output token。

## 风险与缓解

- 风险：patch 遗漏旧 context 中应该更新的字段。
  - 缓解：currentScene 每轮完整替换；角色关键状态 `currentStatus` 要求本轮出现角色时必须输出。
- 风险：没有 belief/opinion ID，删除和更新不稳定。
  - 缓解：第一期只追加，服务端预算裁剪负责控制膨胀；后续如需要精确更新再引入子项 ID。
- 风险：本地 repair 过度修复导致语义偏差。
  - 缓解：只做确定性修复，不创造事实；无法确定时丢弃局部引用或使用 `"unknown"`。
- 风险：patch apply 逻辑变复杂。
  - 缓解：把复杂度集中在 `StoryContextPatchApplier`，调用方只跨一个小 Interface。

## 后续可能的进一步优化

- 给 belief / opinion / relationship 引入稳定 ID，支持精确更新和删除。
- 把 `sourceRefs` 从 item 级改为 patch block 级，进一步减少重复。
- 对 context prompt 中旧 context 做服务端裁剪，只给 extractor 最近相关子集。
- 将 LLM 调用日志接入自动统计脚本，持续输出 context input/output token 趋势。
