import { Env, reloadEnvForTesting } from "./env";

describe("Env", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_TIMEOUT_MS;
    reloadEnvForTesting();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    reloadEnvForTesting();
  });

  it("treats missing LLM provider settings as disabled", () => {
    expect(Env.llm).toBeNull();
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
});
