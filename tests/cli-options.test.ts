import { describe, expect, it } from "vitest";
import { helpText, parseCliArgs, VERSION } from "../src/cli-options.js";

describe("CLI options", () => {
  it("defaults to OpenAI", () => {
    expect(parseCliArgs(["Question"], {})).toMatchObject({
      provider: "openai",
      model: "gpt-5.6",
      prompt: "Question",
    });
  });

  it("selects DeepSeek and its default model", () => {
    expect(
      parseCliArgs(["--provider", "deepseek", "Question"], {}),
    ).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      prompt: "Question",
    });
  });

  it("uses the selected Provider environment model", () => {
    expect(
      parseCliArgs(["--provider", "deepseek", "Question"], {
        OPENAI_MODEL: "ignored-openai-model",
        DEEPSEEK_MODEL: "deepseek-custom",
      }),
    ).toMatchObject({ model: "deepseek-custom" });
  });

  it("configures an OpenAI-compatible Provider from standard environment variables", () => {
    expect(
      parseCliArgs(["--provider", "openai-compatible", "Question"], {
        OPENAI_BASE_URL: "https://api.vendor.example/v1",
        OPENAI_MODEL: "vendor-model",
      }),
    ).toMatchObject({
      provider: "openai-compatible",
      baseURL: "https://api.vendor.example/v1",
      model: "vendor-model",
      prompt: "Question",
    });
  });

  it("does not invent a model for an OpenAI-compatible Provider", () => {
    expect(
      parseCliArgs(["--provider", "openai-compatible", "Question"], {}),
    ).not.toHaveProperty("model");
  });

  it("prefers an explicit model", () => {
    expect(
      parseCliArgs(
        ["--provider", "deepseek", "--model", "custom-model", "Question"],
        { DEEPSEEK_MODEL: "environment-model" },
      ),
    ).toMatchObject({ model: "custom-model" });
  });

  it("rejects unsupported Providers", () => {
    expect(() =>
      parseCliArgs(["--provider", "unknown", "Question"], {}),
    ).toThrow("Unsupported provider");
  });

  it("defaults to streaming with visible tool activity", () => {
    expect(parseCliArgs(["Question"], {})).toMatchObject({
      stream: true,
      quiet: false,
      maxTurns: 8,
    });
  });

  it("accepts runtime overrides", () => {
    expect(
      parseCliArgs(["--no-stream", "--quiet", "--max-turns", "3", "Q"], {}),
    ).toMatchObject({ stream: false, quiet: true, maxTurns: 3 });
  });

  it("rejects an out-of-range turn limit", () => {
    expect(() => parseCliArgs(["--max-turns", "0", "Q"], {})).toThrow(
      "--max-turns",
    );
  });

  it("records sessions by default", () => {
    expect(parseCliArgs(["Question"], {})).toMatchObject({
      session: true,
      json: false,
      continueSession: false,
      listSessions: false,
    });
    expect(parseCliArgs(["Question"], {})).not.toHaveProperty("resume");
  });

  it("parses session selection flags", () => {
    expect(
      parseCliArgs(["--resume", "session-1", "--json", "--no-session", "Q"], {}),
    ).toMatchObject({ resume: "session-1", json: true, session: false });
    expect(parseCliArgs(["-c"], {})).toMatchObject({ continueSession: true });
    expect(parseCliArgs(["--sessions"], {})).toMatchObject({
      listSessions: true,
    });
  });

  it("reads an interactive invocation as a missing prompt", () => {
    expect(parseCliArgs([], {})).not.toHaveProperty("prompt");
  });

  it("defaults to a context budget with compaction on", () => {
    expect(parseCliArgs(["Question"], {})).toMatchObject({
      contextWindow: 100_000,
      compact: true,
    });
  });

  it("parses context flags", () => {
    expect(
      parseCliArgs(["--context-window", "8000", "--no-compact", "Q"], {}),
    ).toMatchObject({ contextWindow: 8_000, compact: false });
  });

  it("rejects an out-of-range context window", () => {
    expect(() => parseCliArgs(["--context-window", "10", "Q"], {})).toThrow(
      "--context-window",
    );
  });

  it("documents both Providers", () => {
    expect(helpText()).toContain("openai, deepseek, or openai-compatible");
    expect(helpText()).toContain("openai-compatible");
    expect(helpText()).toContain("OPENAI_BASE_URL");
    expect(helpText()).toContain("DEEPSEEK_API_KEY");
    expect(helpText()).toContain("--no-stream");
    expect(helpText()).toContain("--resume ID");
    expect(helpText()).toContain("CHIVGENT_HOME");
    expect(helpText()).toContain("--context-window");
    expect(VERSION).toBe("0.7.0");
  });
});
