import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_WRITE_MAX_TURNS,
  helpText,
  parseCliArgs,
  VERSION,
} from "../src/cli-options.js";

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

  it("keeps writes disabled unless --allow-writes is given", () => {
    expect(parseCliArgs([], {})).toMatchObject({
      allowWrites: false,
      maxTurns: DEFAULT_MAX_TURNS,
    });
  });

  it("raises the turn budget when writes are enabled", () => {
    expect(parseCliArgs(["--allow-writes"], {})).toMatchObject({
      allowWrites: true,
      maxTurns: DEFAULT_WRITE_MAX_TURNS,
    });
  });

  it("lets an explicit --max-turns win over the write default", () => {
    expect(parseCliArgs(["--allow-writes", "--max-turns", "3"], {})).toMatchObject({
      allowWrites: true,
      maxTurns: 3,
    });
  });

  it("reads an interactive invocation as a missing prompt", () => {
    expect(parseCliArgs([], {})).not.toHaveProperty("prompt");
  });

  it("documents both Providers", () => {
    expect(helpText()).toContain("openai, deepseek, or openai-compatible");
    expect(helpText()).toContain("openai-compatible");
    expect(helpText()).toContain("OPENAI_BASE_URL");
    expect(helpText()).toContain("DEEPSEEK_API_KEY");
    expect(helpText()).toContain("--no-stream");
    expect(helpText()).toContain("--resume ID");
    expect(helpText()).toContain("CHIVGENT_HOME");
    expect(helpText()).toContain("--allow-writes");
    expect(VERSION).toBe("0.7.1");
  });
});
