import { deriveStorylineTitle, resolveStorylineTitle } from "./storyline-title";

describe("storyline title", () => {
  it("derives a normalized title from the first non-empty line", () => {
    expect(deriveStorylineTitle("\n  雨停   以后  \n第二行")).toBe("雨停 以后");
  });

  it("uses the opening section for stories created from settings", () => {
    expect(
      deriveStorylineTitle(
        "【故事设定】\n旧城。\n\n【开场】\n  林夏走进钟楼。  \n第二行",
      ),
    ).toBe("林夏走进钟楼。");
  });

  it("prefers an explicit title", () => {
    expect(
      resolveStorylineTitle({
        explicitTitle: "  分支故事  ",
        initialText: "原始正文。",
      }),
    ).toBe("分支故事");
  });
});
