import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const stream = () => ({
    isTTY: true,
    rows: 24,
    columns: 80,
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    setEncoding: vi.fn(),
  });
  const liveRegion = {
    listener: vi.fn(),
    stop: vi.fn(),
    resized: vi.fn(),
    reset: vi.fn(),
  };
  return {
    process: {
      argv: ["node", "/workspace/dist/cli.js"],
      env: {} as Record<string, string>,
      stdin: stream(),
      stdout: stream(),
      stderr: stream(),
      cwd: vi.fn(() => "/workspace"),
      on: vi.fn(),
      off: vi.fn(),
      exitCode: 0,
    },
    runRepl: vi.fn(async (_options: Record<string, unknown>) => 0),
    createConfiguredClient: vi.fn(async () => ({})),
    createLocalSession: vi.fn((_config: Record<string, unknown>) => ({
      id: "session-test",
      subscribe: vi.fn(() => () => undefined),
    })),
    createLiveRegion: vi.fn((_options: Record<string, unknown>) => liveRegion),
    liveRegion,
    createEventRenderer: vi.fn(() => vi.fn()),
  };
});

vi.mock("node:process", () => ({ default: harness.process }));
vi.mock("../src/repl.js", () => ({
  BUILT_IN_COMMANDS: [],
  runRepl: harness.runRepl,
}));
vi.mock("../src/providers/client.js", () => ({
  createConfiguredClient: harness.createConfiguredClient,
}));
vi.mock("../src/cli-runtime.js", () => ({
  createLocalSession: harness.createLocalSession,
}));
vi.mock("../src/tui/live.js", () => ({
  createLiveRegion: harness.createLiveRegion,
  terminalWidth: () => 80,
}));
vi.mock("../src/tui/welcome.js", () => ({ welcome: () => "welcome" }));
vi.mock("../src/render.js", () => ({
  createEventRenderer: harness.createEventRenderer,
  createJsonEventWriter: vi.fn(() => vi.fn()),
}));

const { main } = await import("../src/cli.js");

describe("CLI terminal UI wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.process.env = {};
    harness.process.stdin.isTTY = true;
    harness.process.stdout.isTTY = true;
    harness.process.stderr.isTTY = true;
  });

  it("wires default local TTY sessions to the live region and inline composer", async () => {
    expect(await main(["--no-session", "--no-extensions"])).toBe(0);

    expect(harness.createLiveRegion).toHaveBeenCalledOnce();
    expect(harness.runRepl).toHaveBeenCalledOnce();
    expect(harness.runRepl.mock.calls[0]?.[0]).toMatchObject({
      tui: true,
      inlineComposer: true,
      output: harness.process.stderr,
      liveRegion: harness.liveRegion,
    });
    expect((harness.createLocalSession.mock.calls[0]?.[0].options as Record<string, unknown>)).toMatchObject({
      allowWrites: false,
      allowShell: false,
    });
    expect(harness.createLocalSession.mock.calls[0]?.[0].options).not.toHaveProperty("permissionMode");
  });

  it("keeps --simple on the append-only renderer and stdout REPL", async () => {
    expect(await main(["--simple", "--no-session", "--no-extensions"])).toBe(0);

    expect(harness.createLiveRegion).not.toHaveBeenCalled();
    expect(harness.createEventRenderer).toHaveBeenCalledOnce();
    expect(harness.runRepl.mock.calls[0]?.[0]).toMatchObject({
      tui: false,
      inlineComposer: false,
      output: harness.process.stdout,
    });
  });

  it("keeps explicit --tui working with redirected stdout", async () => {
    harness.process.stdout.isTTY = false;

    expect(await main(["--tui", "--no-session", "--no-extensions"])).toBe(0);
    expect(harness.runRepl.mock.calls[0]?.[0]).toMatchObject({
      tui: true,
      inlineComposer: true,
      output: harness.process.stderr,
    });
  });

  it("leaves the rich interface active under NO_COLOR without passing ANSI color", async () => {
    harness.process.env.NO_COLOR = "1";

    expect(await main(["--no-session", "--no-extensions"])).toBe(0);
    expect(harness.createLiveRegion.mock.calls[0]?.[0]).toMatchObject({ color: false });
    expect(harness.runRepl.mock.calls[0]?.[0].tui).toBe(true);
  });

  it("uses the simple renderer for TERM=dumb and rejects an explicit rich request", async () => {
    harness.process.env.TERM = "dumb";

    expect(await main(["--no-session", "--no-extensions"])).toBe(0);
    expect(harness.runRepl.mock.calls[0]?.[0]).toMatchObject({ tui: false, inlineComposer: false });

    vi.clearAllMocks();
    expect(await main(["--tui", "--no-session", "--no-extensions"])).toBe(1);
    expect(harness.process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("TERM=dumb"));
    expect(harness.runRepl).not.toHaveBeenCalled();
  });
});
