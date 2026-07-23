import { Env, reloadEnvForTesting } from "./env";

describe("Env", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LLM_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_MODEL: "",
      LLM_TIMEOUT_MS: "",
      STORY_HISTORY_APPEND_SCORE: "",
      STORY_HISTORY_DIALOGUE_SCORE: "",
      STORY_HISTORY_SCORE_LIMIT: "",
      STORY_HISTORY_ROUND_LIMIT: "",
    };
    reloadEnvForTesting();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("treats missing LLM provider settings as disabled", () => {
    expect(Env.llm).toBeNull();
    expect(Env.story).toEqual({
      historyAppendScore: 5,
      historyDialogueScore: 1,
      historyScoreLimit: 100,
    });
  });

  it("parses complete LLM provider settings", () => {
    process.env.LLM_BASE_URL = "https://llm.example.com/v1/";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL = "test-model";
    process.env.LLM_TIMEOUT_MS = "12345";

    reloadEnvForTesting();

    expect(Env.llm).toEqual({
      baseUrl: "https://llm.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 12345,
    });
  });

  it("rejects partial LLM provider settings", () => {
    process.env.LLM_BASE_URL = "https://llm.example.com/v1";
    process.env.LLM_API_KEY = "test-key";

    expect(() => reloadEnvForTesting()).toThrow(
      "LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must all be set together",
    );
  });

  it("parses story history score settings", () => {
    process.env.STORY_HISTORY_APPEND_SCORE = "8";
    process.env.STORY_HISTORY_DIALOGUE_SCORE = "2";
    process.env.STORY_HISTORY_SCORE_LIMIT = "64";

    reloadEnvForTesting();

    expect(Env.story).toEqual({
      historyAppendScore: 8,
      historyDialogueScore: 2,
      historyScoreLimit: 64,
    });
  });

  it("rejects invalid story history score settings", () => {
    process.env.STORY_HISTORY_APPEND_SCORE = "0";

    expect(() => reloadEnvForTesting()).toThrow(
      "STORY_HISTORY_APPEND_SCORE must be a positive integer",
    );
  });

  it("does not read the removed story history round limit", () => {
    process.env.STORY_HISTORY_ROUND_LIMIT = "12";

    reloadEnvForTesting();

    expect(Env.story).toEqual({
      historyAppendScore: 5,
      historyDialogueScore: 1,
      historyScoreLimit: 100,
    });
  });
});
