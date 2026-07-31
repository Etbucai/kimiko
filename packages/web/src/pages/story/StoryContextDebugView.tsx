import type { JSX } from "react";
import type {
  StoryCharacterBelief,
  StoryCharacterContext,
  StoryContextSnapshot,
  StoryWorldFact,
} from "@kimiko/schema";

interface StoryContextDebugViewProps {
  readonly context: StoryContextSnapshot;
}

const factVisibilityLabels: Record<StoryWorldFact["visibility"], string> = {
  observable: "可观察",
  public: "公开",
  hidden: "隐藏",
};

const factVisibilityOrder: readonly StoryWorldFact["visibility"][] = [
  "observable",
  "public",
  "hidden",
];

export function StoryContextDebugView({
  context,
}: StoryContextDebugViewProps): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <ContextSection
        description="角色完整人格、认知、主观意见、误解和行动倾向。"
        title="角色认知"
      >
        {context.characters.length === 0 ? (
          <EmptyContextText text="暂无角色认知。" />
        ) : (
          <div className="flex flex-col gap-4">
            {context.characters.map((character) => (
              <CharacterCard character={character} key={character.id} />
            ))}
          </div>
        )}
      </ContextSection>

      <ContextSection
        description="下一轮生成时的当前环境摘要。"
        title="当前场景"
      >
        <dl className="m-0 grid gap-3 text-sm leading-6 text-(--text-h)">
          <ContextField label="地点" value={context.currentScene.location} />
          <ContextField
            label="时间/阶段"
            value={context.currentScene.timeLabel}
          />
          <ContextField
            label="场景状态"
            value={context.currentScene.sceneStatus}
          />
          <ContextTags
            label="在场角色"
            values={context.currentScene.presentCharacterIds}
          />
          <ContextTags
            label="可观察事实"
            values={context.currentScene.observableFactIds}
          />
          <ContextTags
            label="来源段落"
            values={context.currentScene.sourceSegmentIds}
          />
        </dl>
      </ContextSection>

      <ContextSection
        description="真实发生或成立的世界事实，按可见性分组。"
        title="世界事实"
      >
        <div className="flex flex-col gap-4">
          {factVisibilityOrder.map((visibility) => (
            <FactGroup
              facts={context.worldFacts.filter(
                (fact) => fact.visibility === visibility,
              )}
              key={visibility}
              visibility={visibility}
            />
          ))}
        </div>
      </ContextSection>
    </div>
  );
}

interface ContextSectionProps {
  readonly children: JSX.Element;
  readonly description: string;
  readonly title: string;
}

function ContextSection({
  children,
  description,
  title,
}: ContextSectionProps): JSX.Element {
  return (
    <section className="rounded-3xl border border-(--border) bg-(--panel-bg) p-5 shadow-(--shadow) md:p-6">
      <h2 className="m-0 text-lg font-bold text-(--text-h)">{title}</h2>
      <p className="mt-1 mb-5 text-sm leading-6 text-(--text)">{description}</p>
      {children}
    </section>
  );
}

function CharacterCard({
  character,
}: {
  readonly character: StoryCharacterContext;
}): JSX.Element {
  return (
    <article className="rounded-2xl border border-(--border) bg-(--input-bg) p-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-base font-bold text-(--text-h)">
            {character.name}
          </h3>
          <Tag value={character.id} />
        </div>
        {character.aliases.length > 0 ? (
          <p className="m-0 text-xs leading-5 text-(--text)">
            别名：{character.aliases.join("、")}
          </p>
        ) : null}
      </div>

      <dl className="mt-4 mb-0 grid gap-3 text-sm leading-6 text-(--text-h)">
        <ContextField label="身份" value={character.identity} />
        <ContextField label="当前状态" value={character.currentStatus} />
        <ContextTags label="特征" values={character.traits} />
        <ContextTags label="动机" values={character.motivations} />
        <ContextTags label="行动倾向" values={character.actionTendencies} />
        <ContextTags label="来源段落" values={character.sourceSegmentIds} />
      </dl>

      <CharacterSubsection title="关系">
        {character.relationships.length === 0 ? (
          <EmptyContextText text="暂无关系。" />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {character.relationships.map((relationship) => (
              <li
                className="rounded-xl border border-(--border) px-3 py-2 text-sm leading-6 text-(--text-h)"
                key={`${relationship.targetCharacterId}:${relationship.text}`}
              >
                <span className="font-semibold">
                  {relationship.targetCharacterId}：
                </span>
                {relationship.text}
                <TagList values={relationship.sourceSegmentIds} />
              </li>
            ))}
          </ul>
        )}
      </CharacterSubsection>

      <CharacterSubsection title="已知/相信">
        {character.beliefs.length === 0 ? (
          <EmptyContextText text="暂无认知。" />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {character.beliefs.map((belief) => (
              <BeliefItem belief={belief} key={belief.text} />
            ))}
          </ul>
        )}
      </CharacterSubsection>

      <CharacterSubsection title="主观意见">
        {character.opinions.length === 0 ? (
          <EmptyContextText text="暂无主观意见。" />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {character.opinions.map((opinion) => (
              <li
                className="rounded-xl border border-(--border) px-3 py-2 text-sm leading-6 text-(--text-h)"
                key={`${opinion.target}:${opinion.text}`}
              >
                <span className="font-semibold">{opinion.target}：</span>
                {opinion.text}
                <TagList values={opinion.sourceSegmentIds} />
              </li>
            ))}
          </ul>
        )}
      </CharacterSubsection>
    </article>
  );
}

function CharacterSubsection({
  children,
  title,
}: {
  readonly children: JSX.Element;
  readonly title: string;
}): JSX.Element {
  return (
    <section className="mt-4">
      <h4 className="m-0 mb-2 text-sm font-bold text-(--text-h)">{title}</h4>
      {children}
    </section>
  );
}

function BeliefItem({
  belief,
}: {
  readonly belief: StoryCharacterBelief;
}): JSX.Element {
  const className =
    belief.truthStatus === "false"
      ? "border-(--danger) bg-(--danger-bg) text-(--danger)"
      : "border-(--border) text-(--text-h)";

  return (
    <li
      className={`rounded-xl border px-3 py-2 text-sm leading-6 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag value={belief.truthStatus} />
        <span>{belief.text}</span>
      </div>
      {belief.factIds.length > 0 ? (
        <TagList label="关联事实" values={belief.factIds} />
      ) : null}
      <TagList label="来源" values={belief.sourceSegmentIds} />
    </li>
  );
}

function FactGroup({
  facts,
  visibility,
}: {
  readonly facts: readonly StoryWorldFact[];
  readonly visibility: StoryWorldFact["visibility"];
}): JSX.Element {
  return (
    <section>
      <h3 className="m-0 mb-3 text-base font-bold text-(--text-h)">
        {factVisibilityLabels[visibility]}
      </h3>
      {facts.length === 0 ? (
        <EmptyContextText text={`暂无 ${visibility} 事实。`} />
      ) : (
        <div className="flex flex-col gap-3">
          {facts.map((fact) => (
            <FactCard fact={fact} key={fact.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function FactCard({ fact }: { readonly fact: StoryWorldFact }): JSX.Element {
  const hiddenClassName =
    fact.visibility === "hidden"
      ? "border-(--danger) bg-(--danger-bg)"
      : "border-(--border) bg-(--input-bg)";

  return (
    <article className={`rounded-2xl border p-4 ${hiddenClassName}`}>
      <div className="mb-2 flex flex-wrap gap-2">
        <Tag value={fact.id} />
        <Tag value={fact.kind} />
        <Tag value={fact.status} />
      </div>
      <p className="m-0 text-sm leading-6 text-(--text-h)">{fact.text}</p>
      <TagList label="来源" values={fact.sourceSegmentIds} />
    </article>
  );
}

function ContextField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element | null {
  if (value.length === 0) {
    return null;
  }

  return (
    <div>
      <dt className="font-semibold">{label}</dt>
      <dd className="m-0 text-(--text)">{value}</dd>
    </div>
  );
}

function ContextTags({
  label,
  values,
}: {
  readonly label: string;
  readonly values: readonly string[];
}): JSX.Element | null {
  if (values.length === 0) {
    return null;
  }

  return (
    <div>
      <dt className="font-semibold">{label}</dt>
      <dd className="m-0">
        <TagList values={values} />
      </dd>
    </div>
  );
}

function TagList({
  label,
  values,
}: {
  readonly label?: string;
  readonly values: readonly string[];
}): JSX.Element | null {
  if (values.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {label !== undefined ? (
        <span className="text-xs font-semibold text-(--text)">{label}：</span>
      ) : null}
      {values.map((value) => (
        <Tag key={value} value={value} />
      ))}
    </div>
  );
}

function Tag({ value }: { readonly value: string }): JSX.Element {
  return (
    <span className="inline-flex rounded-full border border-(--border) px-2 py-0.5 text-xs font-semibold text-(--text)">
      {value}
    </span>
  );
}

function EmptyContextText({ text }: { readonly text: string }): JSX.Element {
  return (
    <p className="m-0 rounded-2xl border border-(--border) px-4 py-3 text-sm text-(--text)">
      {text}
    </p>
  );
}
