import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { runRepl } from "../src/repl.js";
import { LocalWorkspace } from "../src/workspace.js";
import { createLiveRegion } from "../src/tui/live.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => vi.unstubAllEnvs());

function session() {
  return new AgentSession({ agent: {
    systemPrompt: "test", tools: [], maxTurns: 1,
    workspace: new LocalWorkspace(process.cwd()),
    llm: { async complete() {
      return { message: { role: "assistant" as const, content: "answer", toolCalls: [] } };
    } },
  } });
}

describe("rendered input line", () => {
  it("inserts a pasted Unicode string at the cursor and keeps editing in sync", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(32, 12);
    const current = session();
    const run = runRepl({ session: current, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("tail");
      screen.input.write("\x01");
      const pasted = "中文输入".repeat(5);
      const bytes = Buffer.from(pasted);
      screen.input.write(bytes.subarray(0, 2)); // Split within a UTF-8 character.
      screen.input.write(bytes.subarray(2));
      screen.input.write("\x05");
      await screen.flush();
      expect(screen.visible().filter(Boolean).join("")).toBe(`› ${pasted}tail`);
      screen.input.write("\r");
      await vi.waitFor(() => expect(current.turns).toBe(1));
      expect(current.messages.find((message) => message.role === "user")?.content).toBe(`${pasted}tail`);
      screen.input.write("\x04");
      await run;
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("keeps a wrapped draft editable through idle resize", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(80, 24);
    const run = runRepl({ session: session(), ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("draft".repeat(20));
      await screen.flush();
      screen.resize(32, 12);
      await screen.flush();
      screen.input.write("\x01");
      screen.input.write("\x03");
      await screen.flush();
      expect(screen.visible().filter(Boolean)).toEqual(["› "]);
      screen.resize(120, 40);
      await screen.flush();
      expect(screen.visible().filter(Boolean)).toEqual(["› "]);
      screen.input.write("\x04");
      await run;
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("clears a wrapped draft on Ctrl+C before accepting a new command", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness(32, 12);
    const current = session();
    const run = runRepl({ session: current, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("DISCARD_THIS_DRAFT".repeat(8));
      screen.input.write("\x01"); // Cancel with the cursor away from the end.
      screen.input.write("\x03");
      await screen.flush();
      expect(screen.visible().filter(Boolean)).toEqual(["› "]);
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   0"));
      expect(current.turns).toBe(0);
      screen.input.write("\x04");
      await run;
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("removes the EOF prompt before a shell writes its own prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness();
    const run = runRepl({ session: session(), ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("\x04");
      expect(await run).toBe(0);
      screen.output.write("shell$ ");
      await screen.flush();
      expect(screen.visible().filter(Boolean)).toEqual(["shell$ "]);
      expect(screen.input.raw).toBe(false);
    } finally { screen.input.end(); await run; screen.dispose(); }
  });

  it("never queues extra lines from one input chunk, even for an immediate provider", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const screen = terminalHarness();
    const current = session();
    const run = runRepl({ session: current, ...screen, stderr: screen.output, tui: true });
    try {
      screen.input.write("first\rEXTRA\r/clear\r");
      await vi.waitFor(() => expect(current.turns).toBe(1));
      // A command sent once the first run has finished must be accepted.
      screen.input.write("/session\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("prompts:   1"));
      expect(screen.bytes()).not.toContain("EXTRA");
      expect(screen.bytes()).not.toContain("Transcript cleared");
      expect(current.messages.length).toBeGreaterThan(0);
      screen.input.write("\x04");
      await run;
    } finally { screen.input.end(); await run; screen.dispose(); }
  });
});

describe("rendered live-region resize", () => {
  it.each([[32, 12], [16, 5]])("retains history and one status through 80×24 → %i×%i → 120×40", async (cols, rows) => {
    const screen = terminalHarness();
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns,
      height: () => screen.output.rows, now: () => 1000 });
    screen.output.on("resize", region.resized);
    try {
      screen.output.write(Array.from({ length: 20 }, (_, i) => `HISTORY-${i}\n`).join(""));
      region.listener({ type: "agent_start", prompt: "test", maxTurns: 4 });
      region.listener({ type: "message_update", turn: 1, delta: ["a".repeat(70), "b".repeat(70), "c".repeat(70)].join("\n") });
      await screen.flush();
      screen.resize(cols, rows);
      await screen.flush();
      expect(screen.visible().filter((line) => line.includes("thinking"))).toHaveLength(1);
      screen.resize(120, 40);
      await screen.flush();
      expect(screen.visible().filter((line) => line.includes("thinking"))).toHaveLength(1);
      region.listener({ type: "agent_end", status: "completed", turnCount: 1, messages: [] });
      await screen.flush();
      expect(screen.history().join("\n")).toContain("HISTORY-19");
      expect(screen.visible().join("\n")).not.toContain("thinking");
    } finally { region.stop(); screen.dispose(); }
  });
});
