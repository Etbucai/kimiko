import type { StoryContextSnapshot } from "@kimiko/schema";
import { StorylineCopyFailedError } from "./storyline.errors";
import { remapStoryContextSegmentIds } from "./storyline-context-remap";

describe("remapStoryContextSegmentIds", () => {
  const context: StoryContextSnapshot = {
    worldFacts: [
      {
        id: "fact_1",
        kind: "event",
        text: "林夏抵达钟楼。",
        status: "active",
        visibility: "observable",
        sourceSegmentIds: ["1"],
      },
    ],
    characters: [
      {
        id: "char_1",
        name: "林夏",
        aliases: [],
        identity: "调查员",
        traits: ["谨慎"],
        relationships: [
          {
            targetCharacterId: "char_2",
            text: "正在寻找程溪。",
            sourceSegmentIds: ["2"],
          },
        ],
        motivations: ["找到真相"],
        currentStatus: "位于钟楼",
        beliefs: [
          {
            text: "钟楼藏有线索。",
            truthStatus: "unknown",
            factIds: ["fact_1"],
            sourceSegmentIds: ["2"],
          },
        ],
        opinions: [
          {
            target: "钟楼",
            text: "这里很危险。",
            sourceSegmentIds: ["1"],
          },
        ],
        actionTendencies: ["先观察"],
        sourceSegmentIds: ["1", "2"],
      },
      {
        id: "char_2",
        name: "程溪",
        aliases: [],
        identity: "",
        traits: [],
        relationships: [],
        motivations: [],
        currentStatus: "",
        beliefs: [],
        opinions: [],
        actionTendencies: [],
        sourceSegmentIds: ["2"],
      },
    ],
    currentScene: {
      location: "钟楼",
      timeLabel: "夜晚",
      presentCharacterIds: ["char_1"],
      observableFactIds: ["fact_1"],
      sceneStatus: "调查进行中",
      sourceSegmentIds: ["1", "2"],
    },
  };

  it("remaps every segment source without changing context-local ids", () => {
    const result = remapStoryContextSegmentIds({
      context,
      segmentIdMap: new Map([
        ["1", "101"],
        ["2", "102"],
      ]),
    });

    expect(result.worldFacts[0]?.sourceSegmentIds).toEqual(["101"]);
    expect(result.characters[0]).toMatchObject({
      id: "char_1",
      relationships: [{ sourceSegmentIds: ["102"] }],
      beliefs: [{ factIds: ["fact_1"], sourceSegmentIds: ["102"] }],
      opinions: [{ sourceSegmentIds: ["101"] }],
      sourceSegmentIds: ["101", "102"],
    });
    expect(result.characters[1]?.sourceSegmentIds).toEqual(["102"]);
    expect(result.currentScene).toMatchObject({
      presentCharacterIds: ["char_1"],
      observableFactIds: ["fact_1"],
      sourceSegmentIds: ["101", "102"],
    });
    expect(context.currentScene.sourceSegmentIds).toEqual(["1", "2"]);
  });

  it("fails when context references a segment outside the copied prefix", () => {
    expect(() =>
      remapStoryContextSegmentIds({
        context,
        segmentIdMap: new Map([["1", "101"]]),
      }),
    ).toThrow(StorylineCopyFailedError);
  });
});
