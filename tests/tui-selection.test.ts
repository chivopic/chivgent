import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { terminalColorEnabled, useTui } from "../src/tui/selection.js";

function select(argv: readonly string[] = [], overrides: Partial<Parameters<typeof useTui>[0]> = {}): boolean {
  const options = parseCliArgs(argv, {});
  return useTui({
    explicit: options.tui,
    simple: options.simple,
    interactive: true,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    json: options.json,
    serve: options.serve,
    connect: options.connect !== undefined,
    ...overrides,
  });
}

describe("CLI interface selection", () => {
  it("wires an ordinary local TTY session to the rich interface", () => {
    const options = parseCliArgs([], {});
    const richTui = select();

    // These are the same parsed options passed to createLocalSession by cli.ts.
    // UI selection must not grant writes or shell capabilities.
    expect(richTui).toBe(true);
    expect(options).toMatchObject({ allowWrites: false, allowShell: false });
    expect(options).not.toHaveProperty("permissionMode");
  });

  it.each([
    ["piped stdin", { stdinIsTTY: false }],
    ["piped stdout", { stdoutIsTTY: false }],
    ["piped stderr", { stderrIsTTY: false }],
    ["one-shot prompt", { interactive: false }],
    ["JSON", { json: true }],
    ["serve", { serve: true }],
    ["remote connect", { connect: true }],
    ["TERM=dumb", { term: "dumb" }],
  ] as const)("keeps %s on the simple renderer by default", (_name, overrides) => {
    expect(select([], overrides)).toBe(false);
  });

  it("honors --simple and retains explicit --tui with redirected stdout", () => {
    expect(select(["--simple"])).toBe(false);
    expect(select(["--tui"], { stdoutIsTTY: false })).toBe(true);
  });

  it("keeps the rich interface when NO_COLOR is set and disables ANSI styling", () => {
    expect(select([], { term: "xterm-256color" })).toBe(true);
    expect(terminalColorEnabled(true, { NO_COLOR: "1", TERM: "xterm-256color" })).toBe(false);
    expect(terminalColorEnabled(true, { TERM: "dumb" })).toBe(false);
    expect(terminalColorEnabled(true, { TERM: "xterm-256color" })).toBe(true);
  });
});
