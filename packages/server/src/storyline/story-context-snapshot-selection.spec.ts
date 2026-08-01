import type { StoryContextSnapshot } from "@kimiko/schema";
import { serializeStoryContext } from "./storyline-context-normalize";
import {
  selectStoryContextSnapshotAtCutoff,
  StoryContextSnapshotSelectionError,
} from "./story-context-snapshot-selection";

describe("selectStoryContextSnapshotAtCutoff", () => {
  const segments = [
    createSegment({ id: 1, orderIndex: 0, type: "initial" }),
    createSegment({ id: 2, orderIndex: 1 }),
    createSegment({
      id: 3,
      orderIndex: 2,
      previousContext: createContext(["1", "2"]),
      previousContextOrderIndex: 1,
    }),
  ] as const;

  it("returns null when no context has been extracted", () => {
    expect(
      selectStoryContextSnapshotAtCutoff({
        contextRow: undefined,
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toBeNull();
    expect(
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(createContext(["1"])),
          extractedThroughOrderIndex: 0,
        },
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toBeNull();
  });

  it("uses the current context when its cursor is within the cutoff", () => {
    const context = createContext(["1", "2"]);

    expect(
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(context),
          extractedThroughOrderIndex: 1,
        },
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toEqual({
      context,
      extractedThroughOrderIndex: 1,
    });
  });

  it("rolls back to the first excluded segment previous context", () => {
    const currentContext = createContext(["1", "2", "3"]);

    expect(
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(currentContext),
          extractedThroughOrderIndex: 2,
        },
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toEqual({
      context: createContext(["1", "2"]),
      extractedThroughOrderIndex: 1,
    });
  });

  it("returns null when the rollback snapshot is empty", () => {
    expect(
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(createContext(["1", "2"])),
          extractedThroughOrderIndex: 2,
        },
        cutoffOrderIndex: 0,
        segments: [
          createSegment({ id: 1, orderIndex: 0, type: "initial" }),
          createSegment({ id: 2, orderIndex: 1 }),
        ],
      }),
    ).toBeNull();
  });

  it("rejects snapshots that reference a segment after the cutoff", () => {
    expect(() =>
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(createContext(["1", "3"])),
          extractedThroughOrderIndex: 1,
        },
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toThrow(StoryContextSnapshotSelectionError);
  });

  it("rejects invalid context JSON and unsafe rollback cursors", () => {
    expect(() =>
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: "not json",
          extractedThroughOrderIndex: 1,
        },
        cutoffOrderIndex: 1,
        segments,
      }),
    ).toThrow(StoryContextSnapshotSelectionError);

    expect(() =>
      selectStoryContextSnapshotAtCutoff({
        contextRow: {
          contextJson: serializeStoryContext(createContext(["1", "2", "3"])),
          extractedThroughOrderIndex: 3,
        },
        cutoffOrderIndex: 1,
        segments: [
          createSegment({ id: 1, orderIndex: 0, type: "initial" }),
          createSegment({ id: 2, orderIndex: 1 }),
          createSegment({
            id: 3,
            orderIndex: 2,
            previousContext: createContext(["1", "2"]),
            previousContextOrderIndex: 2,
          }),
        ],
      }),
    ).toThrow(StoryContextSnapshotSelectionError);
  });
});

function createSegment(input: {
  readonly id: number;
  readonly orderIndex: number;
  readonly previousContext?: StoryContextSnapshot;
  readonly previousContextOrderIndex?: number;
  readonly type?: "initial" | "generated";
}) {
  return {
    id: input.id,
    orderIndex: input.orderIndex,
    previousContextJson:
      input.previousContext === undefined
        ? null
        : serializeStoryContext(input.previousContext),
    previousContextOrderIndex: input.previousContextOrderIndex ?? null,
    type: input.type ?? ("generated" as const),
  };
}

function createContext(sourceSegmentIds: string[]): StoryContextSnapshot {
  return {
    worldFacts:
      sourceSegmentIds.length === 0
        ? []
        : [
            {
              id: "fact_1",
              kind: "event",
              text: "林夏抵达钟楼。",
              status: "active",
              visibility: "observable",
              sourceSegmentIds,
            },
          ],
    characters: [],
    currentScene: {
      location: "钟楼",
      timeLabel: "夜晚",
      presentCharacterIds: [],
      observableFactIds: sourceSegmentIds.length === 0 ? [] : ["fact_1"],
      sceneStatus: "调查正在进行。",
      sourceSegmentIds,
    },
  };
}
