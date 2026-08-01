# 故事上下文与角色认知 PRD

## 背景

当前故事线已经支持新建、续写、重写和互动对话。服务端通过角色摘要维护长期上下文，缓解角色身份、关系、动机和当前状态在长故事线中漂移的问题。

现有角色摘要是全局视角：它描述“故事中重要角色当前是什么状态”，但不区分“世界真实发生了什么”和“某个角色知道或相信了什么”。当故事需要制造秘密、误会、隐瞒、错误判断时，全局摘要容易让 Agent 以接近上帝视角的方式写角色行动。

本期希望把上下文压缩从“角色摘要”升级为“故事上下文”，将真实世界事实与角色认知分开维护。生成时，角色行动、台词和心理只能基于该角色自身认知，以及当前场景中可观察的世界事实；不应依赖其它角色认知，也不应依赖未激活、不可观察的隐藏事实。

## 方案评价

该方案方向正确，适合当前故事生成产品继续强化“误会”和“冲突”的戏剧性。

主要收益：

- 防止角色使用自己未获知的信息，减少上帝视角泄露。
- 支持角色基于错误记忆、主观偏见、片面认知做出行动。
- 世界事实仍作为真实因果基准，角色认知与真实事实冲突时可以自然制造戏剧张力。
- 上下文压缩从单一摘要升级为结构化状态，更适合长故事线。

主要代价：

- 上下文 extractor 的责任显著变重，需要同时维护世界事实、角色完整认知和当前场景。
- 生成前需要自动识别活跃角色，否则无法决定注入哪些角色认知。
- 同一 prompt 中同时包含多个活跃角色的认知块时，仍存在模型串用认知的风险，需要强约束 prompt 和回归测试。
- 本期不注入隐藏事实，因此隐藏事实不会自动触发环境因果，只能在其变成当前场景可观察事实后参与生成。
- 替换现有 summary 会带来接口、数据库、实时事件和前端调试入口的系统性改造。

结论：建议作为 `008` 新主题推进，定位为服务端上下文系统升级，而不是对现有角色摘要的小修。

## 用户定位

- 面向内部测试者。
- 内部测试者关注长故事线中角色是否更像“只知道自己该知道的事情”。
- 本期不把故事上下文做成正式用户功能，不提供用户编辑入口。

## 本轮目标

- 用“故事上下文”替换现有“角色摘要”。
- 故事上下文包含三块：
  - 世界事实：真实发生的事件、词条、设定或环境状态。
  - 角色认知：每个角色的完整人格、已知信息、主观意见、行动倾向和错误记忆。
  - 当前场景：当前位置、时间阶段、在场角色、当前可观察事实和简短场景状态。
- 每轮正文生成完成后，由 context extractor 输出新的完整故事上下文快照。
- 创建、续写、互动和重写都使用同一套故事上下文维护机制。
- 生成角色行动时，只注入当前场景可观察事实和活跃角色的认知。
- 当角色认知与世界事实冲突时，角色行动按认知走，环境反馈按世界事实走。
- 错误记忆只从正文中已经出现的误解沉淀，不由系统主动捏造。
- 每条事实和认知必须记录来源 segment，方便调试和重写回滚。
- 保存正文与保存新上下文保持原子性。context extractor 失败时，本轮生成不进入正式故事线。

## 非目标

- 本期不做用户编辑事实或角色认知。
- 本期不做正式的上下文管理 UI。
- 本期不把隐藏事实注入生成 prompt。
- 本期不维护未来剧情计划、作者意图或伏笔计划。
- 本期不做异步重试。正文生成成功但 context extractor 失败时，本轮仍视为失败。
- 本期不做复杂实体消歧。服务端只做强匹配合并。
- 本期不做完整世界模拟、空间拓扑或物品系统。
- 本期不保证模型绝不泄露认知，只通过结构化上下文、prompt 约束和测试降低风险。

## 核心概念

### 故事上下文

故事上下文是系统为单条故事线维护的结构化连续性状态。

故事上下文不是正文，不直接展示给普通用户，也不是作者计划。它只描述已经写入正文并可被抽取的事实、角色认知和当前场景状态。

### 世界事实

世界事实表示故事中真实成立的信息。

世界事实可以包括：

- 已经发生的事件。
- 角色身份、关系、阵营等真实状态。
- 场景地点、环境、物品、公开状态。
- 已经揭示的设定、规则、词条。

世界事实不等于角色知道的内容。一个世界事实可以真实存在，但某个角色不知道，或某个角色对它有错误理解。

### 角色认知

角色认知表示某个角色当前“如何理解世界”和“倾向如何行动”。

角色认知包含完整人格信息，包括：

- 角色显示名、别名。
- 身份、阵营、稳定性格。
- 与其它角色的关系。
- 长期动机和当前目标。
- 当前身体、位置、情绪或行动状态。
- 已知或相信的事实。
- 对事实或角色的主观态度。
- 错误记忆或误解。
- 基于当前认知的行动倾向。

错误认知不要求关联真实世界事实；如果能确定它与某条世界事实冲突，可以通过可选 `factIds` 建立关联。

### 当前场景

当前场景表示下一轮生成时的可观察环境。

当前场景至少包含：

- 位置。
- 时间或阶段。
- 在场角色 IDs。
- 当前可观察的世界事实 IDs。
- 简短场景状态。

生成时只把当前场景标记为可观察的事实注入 prompt。隐藏事实即使真实存在，也不进入本期生成 prompt。

### 活跃角色

活跃角色表示本轮生成中可能产生行动、台词、心理或直接反应的角色。

活跃角色由服务端自动识别，不要求用户手动指定。

识别依据包括：

- 当前场景在场角色。
- 当前续写、重写或互动输入中提到的角色名或别名。
- 最近生成轨迹中正在行动或被直接互动的角色。

生成 prompt 只注入活跃角色的认知，不注入非活跃角色认知。

## 已确认决策

- 第一目标是防止角色泄露未知事实，用于制造冲突和误会。
- 叙事约束采用“行动受限”：角色行动、台词、心理受自身认知限制；旁白可以承接已揭示事实，但不能替角色做未知推理。
- 世界事实包含已发生事实和当前环境事实。
- 当前环境事实由服务端自动从当前场景抽取。
- 角色行动按角色认知走，环境结果按世界事实走。
- 错误记忆只从正文中已出现的误解沉淀。
- 本期是后台能力，不做正式用户编辑 UI。
- 用故事上下文替换现有角色摘要。
- 新上下文顶层结构为 `worldFacts + characters + currentScene`。
- `characters` 包含完整人格和认知，不再另设旧角色摘要。
- 角色认知可以可选引用世界事实 ID。
- 角色 ID 由服务端生成。
- 服务端只在名称或别名强匹配时自动合并角色。
- 上下文数量上限偏大，支持较长故事线。
- 每条事实和认知必须记录 `sourceSegmentIds`。
- 生成 prompt 注入当前可观察事实和活跃角色认知。
- 不注入隐藏事实。
- context extractor 输出新的完整快照。
- context extractor 失败时，本轮正文不保存。
- create 首轮生成后用 `initialStoryText + generatedText` 一次性抽取 context。
- rewrite 读取目标段保存的 `previousContextJson`，用新正文重算 context 并原地替换。
- dialogue 输出 `无事发生` 时保存 dialogue 段，但不更新 context。
- 对外命名从 `summary` 改为 `context`。
- 新文档落在 `docs/008/`。

## 产品规则

### 普通用户体验

普通用户不直接感知故事上下文。

用户继续使用现有故事生成能力：

- 新建故事线。
- 续写。
- 重写最新生成段。
- 互动对话。

系统在后台维护 context，并用它改善后续生成。

### 调试体验

第一期保留开发调试能力。

推荐行为：

- 后端提供 `/storylines/:storylineId/context` 调试接口。
- 前端正式入口隐藏，不在普通故事详情页常驻展示。
- 如需前端验证，可使用开发开关或隐藏入口查看 context JSON。

旧“角色摘要”抽屉不再作为正式用户功能展示。

### 生成中状态

现有 `story.summary.started` 概念升级为 context 更新中状态。

推荐新事件名：

```text
story.context.started
```

用户侧文案从“正在记录角色摘要”调整为：

```text
正在更新故事上下文...
```

## 用户链路

### 新建故事线

1. 用户输入初始故事正文。
2. 用户输入首轮续写指令。
3. 服务端基于初始正文和续写指令生成首段正文。
4. 正文流式返回前端，前端展示临时正文。
5. 正文生成完成后，服务端触发 context extractor。
6. context extractor 基于 `initialStoryText + generatedText` 输出完整 context 快照。
7. 服务端在同一事务内保存故事线、initial segment、generated segment 和 context。
8. 前端收到完成事件，临时正文转为正式正文。

### 续写

1. 用户输入续写指令。
2. 服务端读取当前 context。
3. 服务端识别活跃角色。
4. 服务端构造 writer context：
   - 当前场景。
   - 当前可观察世界事实。
   - 活跃角色认知。
   - 必要的近期生成轨迹。
5. Agent 生成续写正文。
6. 正文生成完成后，context extractor 基于旧 context、近期上下文、本轮指令和本轮正文输出新完整 context。
7. 服务端在同一事务内保存 generated segment、`previousContextJson` 和新 context。

### 互动对话

1. 用户输入互动内容。
2. 服务端读取当前 context 和 currentScene。
3. 服务端识别互动中的发起角色和可回应角色。
4. writer prompt 只注入当前可观察事实和活跃角色认知。
5. 如果当前场景没有合适的另一个角色，模型输出 `无事发生`。
6. 如果输出不是 `无事发生`，服务端更新 context。
7. 如果输出是 `无事发生`，服务端保存 dialogue segment，但不更新 context。

### 重写

1. 用户重写最新 generated segment。
2. 服务端读取目标 segment 的 `previousContextJson`。
3. 服务端基于目标段之前的上下文构造 rewrite prompt。
4. Agent 输出完整替换正文。
5. context extractor 基于 `previousContextJson` 和新正文输出新的完整 context。
6. 服务端原地更新目标 segment 和当前 context。
7. rewrite 不改变目标 segment 的 `generationMode`。

## 生成约束

writer prompt 必须明确区分三类信息：

```text
当前可观察世界事实：
- 这些事实是当前场景可观察、公开或已经被相关角色获知的信息。

活跃角色认知：
- 每个角色只能根据自己的认知行动、说话和思考。
- 不要让角色使用其它角色独有的认知。
- 不要让角色使用未注入的隐藏事实。

近期正文轨迹：
- 用于承接语气、动作和局部上下文。
```

角色行动规则：

- 写角色 A 的行动时，只能使用角色 A 的认知和当前可观察事实。
- 写角色 B 的行动时，只能使用角色 B 的认知和当前可观察事实。
- 角色可以基于错误认知做出错误行动。
- 如果角色不知道某事实，不能让角色主动利用该事实。
- 旁白不能替角色做出其认知之外的推理。

世界反馈规则：

- 角色行动的主观动机按角色认知成立。
- 行动造成的环境反馈按世界事实成立。
- 如果角色认知与世界事实冲突，正文可以呈现行动失败、误会加深或冲突爆发。

## 数据模型草案

以下结构是 PRD 级草案，后续技术方案应以 `@kimiko/schema` 中的 Zod schema 作为单一事实来源。

```ts
type StoryContextSnapshot = Readonly<{
  worldFacts: readonly StoryWorldFact[];
  characters: readonly StoryCharacterContext[];
  currentScene: StoryCurrentScene;
}>;

type StoryWorldFact = Readonly<{
  id: string;
  kind:
    "event" | "setting" | "environment" | "relationship" | "status" | "term";
  text: string;
  status: "active" | "resolved";
  visibility: "observable" | "public" | "hidden";
  sourceSegmentIds: readonly string[];
}>;

type StoryCharacterContext = Readonly<{
  id: string;
  name: string;
  aliases: readonly string[];
  identity: string;
  traits: readonly string[];
  relationships: readonly StoryCharacterRelationship[];
  motivations: readonly string[];
  currentStatus: string;
  beliefs: readonly StoryCharacterBelief[];
  opinions: readonly StoryCharacterOpinion[];
  actionTendencies: readonly string[];
  sourceSegmentIds: readonly string[];
}>;

type StoryCharacterBelief = Readonly<{
  text: string;
  truthStatus: "true" | "false" | "unknown";
  factIds: readonly string[];
  sourceSegmentIds: readonly string[];
}>;

type StoryCharacterOpinion = Readonly<{
  target: string;
  text: string;
  sourceSegmentIds: readonly string[];
}>;

type StoryCharacterRelationship = Readonly<{
  targetCharacterId: string;
  text: string;
  sourceSegmentIds: readonly string[];
}>;

type StoryCurrentScene = Readonly<{
  location: string;
  timeLabel: string;
  presentCharacterIds: readonly string[];
  observableFactIds: readonly string[];
  sceneStatus: string;
  sourceSegmentIds: readonly string[];
}>;
```

数量上限建议：

- `characters`: 最多 20。
- `worldFacts`: 最多 80。
- 每个角色 `beliefs`: 最多 30。
- 每个角色 `opinions`: 最多 20。
- 每个角色 `relationships`: 最多 30。
- 每个角色 `actionTendencies`: 最多 12。

超过上限时，context extractor 应合并、压缩或删除低价值条目，而不是无限增长。

## 服务端规则

### 存储

推荐替换现有 summary 存储：

- `storyline_summary` 升级或替换为 `storyline_context`。
- `characters_json` 升级或替换为 `context_json`。
- `storyline_segment.previous_summary_json` 升级或替换为 `previous_context_json`。

本项目允许激进迭代，不要求兼容旧数据。

### 角色 ID

服务端生成角色 ID。

推荐规则：

- context extractor 输出角色候选的 `name` 和 `aliases`。
- 服务端根据已有角色的 `name` 和 `aliases` 做强匹配。
- 强匹配命中时复用已有角色 ID。
- 未命中时分配新角色 ID。
- 不做弱相似度合并。
- 不把疑似同一角色交给用户确认。

### context extractor

context extractor 输入：

- 旧 context。
- initial story text。
- 近期生成轨迹。
- 本轮操作类型：create、append、rewrite、dialogue。
- 本轮用户指令或互动输入。
- 本轮生成正文。

context extractor 输出：

- 新完整 context 快照。

输出要求：

- 只输出 JSON。
- 不创造正文中没有依据的新事实。
- 不主动制造错误记忆。
- 只有正文已经明确产生误解时，才写入 `truthStatus: "false"` 的 belief。
- 每个事实、角色、认知条目都必须带来源 segment。
- 对低价值、重复、过旧的信息进行合并。

### 失败策略

- 正文生成失败：不保存正文，不更新 context。
- context extractor 失败：不保存正文，不更新 context。
- 保存失败：不保存正文，不更新 context。
- 用户取消：不保存正文，不更新 context。
- dialogue 输出 `无事发生`：保存 dialogue segment，不更新 context。

## 前端规则

- 普通用户不看到正式 context 管理界面。
- 旧角色摘要抽屉不再作为普通入口展示。
- 如保留调试查看，必须明确是开发能力。
- 生成正文结束但 context 尚未更新完成时，页面继续展示临时正文。
- context 更新失败时，本轮生成失败，正式故事线不变。
- 实时事件文案从“摘要”升级为“故事上下文”。

## 验收标准

### 防止秘密泄露

给定世界事实中存在隐藏事实，且该事实未进入 currentScene 的 observable facts：

- 活跃角色的行动不能主动利用该隐藏事实。
- 活跃角色台词不能表达自己知道该隐藏事实。
- 活跃角色心理不能推理出该隐藏事实。

### 误解驱动行动

给定角色 A 的 belief 标记为 `truthStatus: "false"`：

- 角色 A 可以基于该错误 belief 做出行动。
- 正文应允许该行动失败、造成冲突或加深误会。
- 其它不知道该误解的角色不应自动按 A 的误解行动。

### 揭示后认知更新

当正文明确揭示某隐藏事实，且角色 A 在场或明确获知：

- context extractor 应更新 currentScene 的 observable facts。
- 角色 A 的 beliefs 应反映新的认知。
- 如果旧 belief 与新事实冲突，应被修正、标记为已更新或删除。

### rewrite 回滚上下文

当用户重写最新 generated segment：

- 服务端使用目标段 `previousContextJson` 重算 context。
- 被旧正文引入的事实和认知不应残留。
- 新正文引入的事实和认知应进入新 context。
- rewrite 后目标 segment 的 `generationMode` 保持不变。

### 创建和续写一致性

- create 后能基于 initial + generated 建立 context。
- append 后能保存 generated segment、previousContextJson 和新 context。
- context extractor 失败时，本轮正文不进入正式故事线。
- 正式故事线与当前 context 始终对应同一轮生成结果。

### dialogue 特殊规则

- dialogue 正常输出时更新 context。
- dialogue 输出 `无事发生` 时保存 segment 但不更新 context。
- dialogue 不新增章节页的既有展示规则保持不变。

## 风险与对策

### 模型串用角色认知

风险：prompt 中同时包含多个活跃角色认知，模型可能让角色 A 使用角色 B 的独有认知。

对策：

- prompt 明确要求按角色分块使用认知。
- 测试覆盖 A/B 互相不知道秘密的场景。
- 生成上下文只注入活跃角色，不注入全员认知。

### extractor 捏造事实

风险：context extractor 为了补全结构主动创造正文中没有的事实或误解。

对策：

- extractor prompt 强制要求只根据输入更新。
- schema 要求所有条目有 `sourceSegmentIds`。
- 测试覆盖“正文没有误解时不能新增错误 belief”。

### 角色合并错误

风险：服务端强匹配过宽会把不同角色合并。

对策：

- 只做姓名和别名的精确强匹配。
- 不做模糊匹配。
- 未命中时新建角色。

### prompt 体积增长

风险：更大上下文上限会推高输入 token。

对策：

- 只注入 currentScene 可观察事实和活跃角色认知。
- context extractor 超上限时合并低价值条目。
- 后续技术方案可增加环境变量控制上限。

### 隐藏因果缺失

风险：本期不注入隐藏事实，隐藏事实不能自动造成环境反馈。

对策：

- 第一目标是防泄密，接受该限制。
- 只有隐藏事实在正文中变为可观察时，才进入生成上下文。
- 后续如需要，可再设计“隐藏因果约束”能力。

## 后续文档建议

本 PRD 确认后，建议继续拆分：

- `docs/008/story-context-server.md`：服务端 schema、数据库迁移、context extractor、writer prompt、rewrite 回滚。
- `docs/008/story-context-fe.md`：摘要入口移除、调试 context 查看、实时事件文案调整。
- `docs/008/story-context-tests.md`：防泄密、误解、揭示、rewrite 回滚的测试样例。
