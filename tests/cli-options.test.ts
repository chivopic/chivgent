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

  it("enables compaction with a default window", () => {
    expect(parseCliArgs([], {})).toMatchObject({
      compaction: true,
      contextWindow: 128_000,
    });
  });

  it("accepts a context window override", () => {
    expect(parseCliArgs(["--context-window", "8000"], {})).toMatchObject({
      contextWindow: 8_000,
    });
  });

  it("rejects an unusably small context window", () => {
    expect(() => parseCliArgs(["--context-window", "10"], {})).toThrow(
      /--context-window must be an integer/,
    );
  });

  it("turns compaction off on request", () => {
    expect(parseCliArgs(["--no-compaction"], {})).toMatchObject({
      compaction: false,
    });
  });

  it("reads an interactive invocation as a missing prompt", () => {
    expect(parseCliArgs([], {})).not.toHaveProperty("prompt");
  });

  it("documents the registered Providers and the resolution order", () => {
    // The Provider line is generated from the registry, so a newly
    // registered Provider appears in --help without touching this module.
    expect(helpText()).toContain("openai, deepseek, openai-compatible");
    expect(helpText()).toContain("OPENAI_BASE_URL");
    expect(helpText()).toContain("DEEPSEEK_API_KEY");
    expect(helpText()).toContain("OPENROUTER_API_KEY");
    expect(helpText()).toContain("--api-key");
    expect(helpText()).toContain(
      "--api-key  ->  environment variable  ->  <CHIVGENT_HOME>/auth.json",
    );
    expect(helpText()).toContain("--no-stream");
    expect(helpText()).toContain("--resume ID");
    expect(helpText()).toContain("CHIVGENT_HOME");
    expect(helpText()).toContain("--allow-writes");
    expect(helpText()).toContain("--context-window");
    expect(helpText()).toContain("--no-compaction");
    expect(helpText()).toContain("--allow-shell");
    expect(VERSION).toBe("0.15.0");
  });
});

describe("--allow-shell", () => {
  it("is off by default", () => {
    expect(parseCliArgs(["question"], {}).allowShell).toBe(false);
  });

  it("turns the shell on and raises the turn limit", () => {
    const options = parseCliArgs(["--allow-shell", "question"], {});

    expect(options.allowShell).toBe(true);
    expect(options.maxTurns).toBe(DEFAULT_WRITE_MAX_TURNS);
  });

  it("stays separate from --allow-writes", () => {
    expect(parseCliArgs(["--allow-writes", "q"], {}).allowShell).toBe(false);
    expect(parseCliArgs(["--allow-shell", "q"], {}).allowWrites).toBe(false);
  });

  it("does not override an explicit turn limit", () => {
    const options = parseCliArgs(["--allow-shell", "--max-turns", "4", "q"], {});

    expect(options.maxTurns).toBe(4);
  });
});

describe("extension options", () => {
  it("loads extensions by default", () => {
    expect(parseCliArgs(["q"], {}).extensions).toBe(true);
  });

  it("turns extensions off", () => {
    expect(parseCliArgs(["--no-extensions", "q"], {}).extensions).toBe(false);
  });

  it("parses the listing and forget flags", () => {
    expect(parseCliArgs(["--extensions"], {}).listExtensions).toBe(true);
    expect(parseCliArgs(["--forget-trust"], {}).forgetTrust).toBe(true);
  });

  it("documents extensions and what trusting one means", () => {
    const text = helpText();

    expect(text).toContain("--no-extensions");
    expect(text).toContain("--forget-trust");
    expect(text).toContain(".chivgent/extensions");
    expect(text).toContain("not\n                   limited by the workspace");
  });
});

describe("remote session options", () => {
  it("is neither serving nor connecting by default", () => {
    const options = parseCliArgs(["q"], {});

    expect(options.serve).toBe(false);
    expect(options.connect).toBeUndefined();
    expect(options.listServers).toBe(false);
  });

  it("parses the three remote flags", () => {
    expect(parseCliArgs(["--serve"], {}).serve).toBe(true);
    expect(parseCliArgs(["--connect", "abc"], {}).connect).toBe("abc");
    expect(parseCliArgs(["--servers"], {}).listServers).toBe(true);
  });

  it("keeps a prompt alongside --connect for a one-shot question", () => {
    const options = parseCliArgs(["--connect", "abc", "what", "changed"], {});

    expect(options.connect).toBe("abc");
    expect(options.prompt).toBe("what changed");
  });

  it("requires a value for --connect", () => {
    expect(() => parseCliArgs(["--connect"], {})).toThrow(/requires a value/);
  });

  it("says who gets the server's capabilities", () => {
    const text = helpText();

    expect(text).toContain("--serve");
    expect(text).toContain("--connect");
    expect(text).toContain("everything the server was started with");
  });
});

describe("json mode and the interactive prompt", () => {
  it("keeps --json a separate concern from streaming and sessions", () => {
    // A regression guard for the wiring: in JSON mode stdout must carry only
    // the event stream, so the REPL's readline output belongs on stderr. The
    // option itself stays a plain boolean the CLI reads when choosing streams.
    expect(parseCliArgs(["--json"], {}).json).toBe(true);
    expect(parseCliArgs(["--json", "--connect", "abc"], {})).toMatchObject({
      json: true,
      connect: "abc",
    });
  });
});
