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

  it("documents both Providers", () => {
    expect(helpText()).toContain("--provider openai|deepseek");
    expect(helpText()).toContain("openai-compatible");
    expect(helpText()).toContain("OPENAI_BASE_URL");
    expect(helpText()).toContain("DEEPSEEK_API_KEY");
    expect(VERSION).toBe("0.4.0");
  });
});
