import type { StoryContextSnapshot } from "@kimiko/schema";
import { applyStoryContextPatch } from "./storyline-context-patch";
import type { StoryContextPatchDraft } from "./storyline-context-patch.types";

describe("applyStoryContextPatch", () => {
  it("adds only patch facts and keeps unchanged previous facts", () => {
    const previousContext = createPreviousContext();
    const context = applyStoryContextPatch({
      previousContext,
      patch: {
        defaultSourceRefs: ["current"],
        worldFacts: {
          add: [
            {
              draftKey: "opened_gate",
              kind: "event",
              text: "林夏推开钟楼铁门。",
              visibility: "observable",
            },
          ],
          update: [],
          resolve: [],
        },
        characters: {
          add: [],
          update: [
            {
              existingId: "char_1",
              currentStatus: "林夏站在钟楼铁门前。",
              beliefsAdded: [
                {
                  text: "林夏知道钟楼铁门已经打开。",
                  truthStatus: "true",
                  factRefs: ["opened_gate"],
                },
              ],
            },
          ],
        },
        currentScene: {
          location: "钟楼门口",
          timeLabel: "傍晚",
          presentCharacterRefs: ["char_1"],
          observableFactRefs: ["opened_gate"],
          sceneStatus: "铁门已经被推开。",
        },
      },
      sourceRefToSegmentId: new Map([["current", "3"]]),
    });

    const previousFact = previousContext.worldFacts[0];
    const previousCharacter = previousContext.characters[0];
    if (previousFact === undefined || previousCharacter === undefined) {
      throw new Error("Expected previous context fixture");
    }

    expect(context.worldFacts).toEqual([
      previousFact,
      {
        id: "fact_2",
        kind: "event",
        text: "林夏推开钟楼铁门。",
        status: "active",
        visibility: "observable",
        sourceSegmentIds: ["3"],
      },
    ]);
    expect(context.characters[0]).toEqual({
      ...previousCharacter,
      currentStatus: "林夏站在钟楼铁门前。",
      beliefs: [
        ...previousCharacter.beliefs,
        {
          text: "林夏知道钟楼铁门已经打开。",
          truthStatus: "true",
          factIds: ["fact_2"],
          sourceSegmentIds: ["3"],
        },
      ],
    });
    expect(context.currentScene).toEqual({
      location: "钟楼门口",
      timeLabel: "傍晚",
      presentCharacterIds: ["char_1"],
      observableFactIds: ["fact_2"],
      sceneStatus: "铁门已经被推开。",
      sourceSegmentIds: ["3"],
    });
  });

  it("reuses existing IDs when add patch matches previous fact and character", () => {
    const context = applyStoryContextPatch({
      previousContext: createPreviousContext(),
      patch: createDuplicatePatch(),
      sourceRefToSegmentId: new Map([["current", "3"]]),
    });

    expect(context.worldFacts).toHaveLength(1);
    expect(context.worldFacts[0]?.id).toBe("fact_1");
    expect(context.worldFacts[0]?.sourceSegmentIds).toEqual(["2", "3"]);
    expect(context.characters).toHaveLength(1);
    expect(context.characters[0]?.id).toBe("char_1");
    expect(context.characters[0]?.beliefs).toHaveLength(2);
  });

  it("drops invalid belief fact refs instead of failing the whole patch", () => {
    const context = applyStoryContextPatch({
      previousContext: createPreviousContext(),
      patch: {
        defaultSourceRefs: ["current"],
        worldFacts: {
          add: [],
          update: [],
          resolve: [],
        },
        characters: {
          add: [],
          update: [
            {
              existingId: "char_1",
              beliefsAdded: [
                {
                  text: "林夏误把角色引用塞进了 factRefs。",
                  truthStatus: "true",
                  factRefs: ["char_1", "fact_1"],
                },
              ],
            },
          ],
        },
        currentScene: {},
      },
      sourceRefToSegmentId: new Map([["current", "3"]]),
    });

    expect(context.characters[0]?.beliefs.at(-1)).toEqual({
      text: "林夏误把角色引用塞进了 factRefs。",
      truthStatus: "true",
      factIds: ["fact_1"],
      sourceSegmentIds: ["3"],
    });
  });
});

function createPreviousContext(): StoryContextSnapshot {
  return {
    worldFacts: [
      {
        id: "fact_1",
        kind: "event",
        text: "林夏走向钟楼。",
        status: "active",
        visibility: "observable",
        sourceSegmentIds: ["2"],
      },
    ],
    characters: [
      {
        id: "char_1",
        name: "林夏",
        aliases: [],
        identity: "调查者",
        traits: ["谨慎"],
        relationships: [],
        motivations: ["调查钟楼"],
        currentStatus: "林夏正在前往钟楼。",
        beliefs: [
          {
            text: "林夏知道自己正在前往钟楼。",
            truthStatus: "true",
            factIds: ["fact_1"],
            sourceSegmentIds: ["2"],
          },
        ],
        opinions: [],
        actionTendencies: ["先观察再行动"],
        sourceSegmentIds: ["2"],
      },
    ],
    currentScene: {
      location: "钟楼外",
      timeLabel: "傍晚",
      presentCharacterIds: ["char_1"],
      observableFactIds: ["fact_1"],
      sceneStatus: "林夏靠近钟楼。",
      sourceSegmentIds: ["2"],
    },
  };
}

function createDuplicatePatch(): StoryContextPatchDraft {
  return {
    defaultSourceRefs: ["current"],
    worldFacts: {
      add: [
        {
          draftKey: "same_fact",
          kind: "event",
          text: "林夏走向钟楼。",
        },
      ],
      update: [],
      resolve: [],
    },
    characters: {
      add: [
        {
          draftKey: "same_character",
          name: "林夏",
          beliefsAdded: [
            {
              text: "林夏确认自己已经接近钟楼。",
              truthStatus: "true",
              factRefs: ["same_fact"],
            },
          ],
        },
      ],
      update: [],
    },
    currentScene: {
      presentCharacterRefs: ["same_character"],
      observableFactRefs: ["same_fact"],
    },
  };
}
