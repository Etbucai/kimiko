import { repairStoryContextPatchValue } from "./storyline-context-patch-repair";

describe("repairStoryContextPatchValue", () => {
  it("repairs deterministic patch schema issues without LLM", () => {
    const result = repairStoryContextPatchValue({
      worldFacts: {
        add: [
          {
            draftKey: "opened_door",
            kind: "event",
            text: "林夏推开门。",
            status: "done",
            visibility: "visible",
          },
        ],
      },
      characters: {
        add: [
          {
            draftKey: "lin_xia",
            name: "林夏",
            beliefsAdded: [
              {
                text: "林夏知道门已经打开。",
                truthStatus: "正确",
              },
            ],
          },
        ],
      },
      currentScene: {
        presentCharacterRefs: "lin_xia",
      },
    });

    expect(result).toEqual({
      success: true,
      patch: {
        defaultSourceRefs: ["current"],
        worldFacts: {
          add: [
            {
              draftKey: "opened_door",
              kind: "event",
              text: "林夏推开门。",
              status: "active",
              visibility: "observable",
            },
          ],
          update: [],
          resolve: [],
        },
        characters: {
          add: [
            {
              draftKey: "lin_xia",
              name: "林夏",
              aliases: undefined,
              traits: undefined,
              relationshipsAdded: [],
              motivations: undefined,
              beliefsAdded: [
                {
                  text: "林夏知道门已经打开。",
                  truthStatus: "unknown",
                  factRefs: [],
                  sourceRefs: undefined,
                },
              ],
              opinionsAdded: [],
              actionTendenciesAdded: undefined,
              sourceRefs: undefined,
            },
          ],
          update: [],
        },
        currentScene: {
          presentCharacterRefs: [],
          observableFactRefs: undefined,
          sourceRefs: undefined,
        },
      },
    });
  });

  it("returns a failed result for non-object patches", () => {
    expect(repairStoryContextPatchValue([])).toEqual({
      success: false,
      message: "Context patch must be a JSON object",
    });
  });
});
