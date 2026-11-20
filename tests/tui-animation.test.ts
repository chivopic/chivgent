import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANIMATION_TICK_MS, SPINNER_FRAMES, shimmerText, spinnerFrame, styleLiveLine } from "../src/tui/animation.js";
import { createLiveRegion } from "../src/tui/live.js";
import { Painter } from "../src/tui/paint.js";
import { EMPTY_STATE, reduce } from "../src/tui/state.js";
import { displayWidth } from "../src/tui/text.js";
import { layoutView, view } from "../src/tui/view.js";
import { terminalHarness } from "./helpers/terminal.js";

afterEach(() => {
  vi.useRealTimers();
});

function recorder() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => void chunks.push(chunk) },
    written: () => chunks.join(""),
  };
}

describe("spinnerFrame", () => {
  it("advances deterministically by elapsedMs and wraps negative values and phase offsets", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(ANIMATION_TICK_MS)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(ANIMATION_TICK_MS * 9)).toBe(SPINNER_FRAMES[9]);
    expect(spinnerFrame(ANIMATION_TICK_MS * 10)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(-500)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(Number.NaN)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(0, 2)).toBe(SPINNER_FRAMES[2]);
    expect(spinnerFrame(0, -1)).toBe(SPINNER_FRAMES[9]);
  });
});

describe("shimmerText", () => {
  it("moves a theme-safe highlight sweep across graphemes while preserving visible text and width", () => {
    expect(shimmerText("", 0)).toBe("");

    const labels = ["thinking", "responding", "running tools", "思考中👩‍💻"];
    for (const label of labels) {
      const frames = new Set<string>();
      for (let step = 0; step < 12; step += 1) {
        const styled = shimmerText(label, step * ANIMATION_TICK_MS);
        frames.add(styled);
        expect(stripVTControlCharacters(styled)).toBe(label);
        expect(displayWidth(styled)).toBe(displayWidth(label));
        // Never hardcode bright white or black foregrounds so both light and dark themes stay legible.
        expect(styled).not.toContain("\u001b[97m");
        expect(styled).not.toContain("\u001b[30m");
      }
      expect(frames.size).toBeGreaterThan(3);
    }
  });
});

describe("styleLiveLine and layoutView", () => {
  it("keeps visible text identical with and without color and strips untrusted escape sequences", () => {
    let state = reduce(EMPTY_STATE, { type: "agent_start", prompt: "go", maxTurns: 4 }, 1_000);
    state = reduce(state, {
      type: "plan_update",
      turn: 1,
      plan: [
        { step: "Inspect \u001b[2Jcode", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    }, 1_000);
    state = reduce(state, { type: "message_update", turn: 1, delta: "Line 1\nLine \u001b[31m2" }, 1_100);
    state = reduce(state, {
      type: "tool_execution_start",
      turn: 1,
      toolCallId: "t1",
      toolName: "read_file",
      arguments: { path: "src/\u001b[2Jindex.ts" },
    }, 1_100);
    state = reduce(state, {
      type: "tool_execution_update",
      turn: 1,
      toolCallId: "t1",
      toolName: "read_file",
      content: "progress \u001b[2Jok",
    }, 1_200);
    for (const id of ["t2", "t3", "t4"]) {
      state = reduce(state, {
        type: "tool_execution_start",
        turn: 1,
        toolCallId: id,
        toolName: "list_files",
        arguments: {},
      }, 1_100);
    }

    for (const width of [8, 20, 24, 30, 80]) {
      const layout = layoutView(state, { width, now: 1_400 });
      for (const line of layout) {
        expect(styleLiveLine(line, 400, false)).toBe(line.plain);
        expect(styleLiveLine(line, 400, false)).not.toContain("\u001b[");

        const colored = styleLiveLine(line, 400, true);
        expect(stripVTControlCharacters(colored)).toBe(line.plain);
        expect(displayWidth(colored)).toBeLessThanOrEqual(width);
        expect(colored).not.toContain("\u001b[2J");
        expect(colored).not.toContain("\u001b[97m");
        expect(colored).not.toContain("\u001b[30m");
      }
    }
  });

  it("renders narrow widths cleanly across thinking, responding, and running-tools", () => {
    for (const status of ["thinking", "responding", "running-tools"] as const) {
      const s = {
        run: {
          turn: 1,
          maxTurns: 4,
          startedAt: 1_000,
          text: "",
          running: [],
          status,
        },
      };
      for (const width of [8, 20, 24, 30, 80]) {
        const lines = view(s, { width, now: 1_200 });
        expect(lines).toHaveLength(1);
        expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(width);
        expect(lines[0]).toMatch(/ctrl\+c|\^C/i);
      }
    }
  });
});

describe("Painter synchronizedOutput", () => {
  it("wraps frames in DEC 2026 markers only when synchronizedOutput is enabled", () => {
    const plainOut = recorder();
    const plainPainter = new Painter({ stream: plainOut.stream });
    plainPainter.render(["one"]);
    expect(plainOut.written()).not.toContain("\u001B[?2026h");
    expect(plainOut.written()).not.toContain("\u001B[?2026l");

    const syncOut = recorder();
    const syncPainter = new Painter({ stream: syncOut.stream, synchronizedOutput: true });
    syncPainter.render(["one"]);
    expect(syncOut.written().startsWith("\u001B[?2026h")).toBe(true);
    expect(syncOut.written().endsWith("\u001B[?2026l")).toBe(true);

    syncOut.chunks.length = 0;
    syncPainter.clear();
    expect(syncOut.written().startsWith("\u001B[?2026h")).toBe(true);
    expect(syncOut.written().endsWith("\u001B[?2026l")).toBe(true);
  });
});

describe("createLiveRegion default animation clock and xterm rendering", () => {
  it("ticks automatically at ANIMATION_TICK_MS and clears timers on pause and end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const out = recorder();
    const region = createLiveRegion({ stream: out.stream, width: () => 80, color: true });

    region.listener({ type: "agent_start", prompt: "test", maxTurns: 4 });
    expect(stripVTControlCharacters(out.written())).toContain("⠋ thinking");

    out.chunks.length = 0;
    vi.advanceTimersByTime(ANIMATION_TICK_MS);
    expect(stripVTControlCharacters(out.written())).toContain("⠙ thinking");

    region.pause();
    out.chunks.length = 0;
    vi.advanceTimersByTime(ANIMATION_TICK_MS * 3);
    expect(out.chunks).toEqual([]);

    region.resume();
    expect(stripVTControlCharacters(out.written())).toContain("⠼ thinking");

    region.listener({ type: "agent_end", status: "completed", turnCount: 1, messages: [] });
    out.chunks.length = 0;
    vi.advanceTimersByTime(ANIMATION_TICK_MS * 3);
    expect(out.chunks).toEqual([]);
  });

  it("renders colored animated frames with DEC 2026 across terminal resizes and erases cleanly", async () => {
    const screen = terminalHarness(80, 24);
    let now = 1_000;
    const region = createLiveRegion({
      stream: screen.output,
      width: () => screen.output.columns,
      height: () => screen.output.rows,
      now: () => now,
      color: true,
      synchronizedOutput: true,
    });
    screen.output.on("resize", region.resized);
    try {
      region.listener({ type: "agent_start", prompt: "test", maxTurns: 4 });
      await screen.flush();
      expect(screen.bytes()).toContain("\u001b[?2026h");
      expect(screen.visible().filter((line) => line.includes("thinking"))).toHaveLength(1);

      now = 1_100;
      region.listener({
        type: "tool_execution_start",
        turn: 1,
        toolCallId: "1",
        toolName: "bash",
        arguments: { command: "npm test" },
      });
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("⠙ bash npm test");
      expect(screen.visible().filter((line) => line.includes("running tools"))).toHaveLength(1);

      screen.resize(32, 12);
      await screen.flush();
      expect(screen.visible().filter((line) => line.includes("tools"))).toHaveLength(1);

      screen.resize(120, 40);
      await screen.flush();
      expect(screen.visible().filter((line) => line.includes("running tools"))).toHaveLength(1);

      region.listener({ type: "agent_end", status: "completed", turnCount: 1, messages: [] });
      await screen.flush();
      expect(screen.visible().join("\n")).not.toContain("running tools");
      expect(screen.visible().join("\n")).not.toContain("bash npm test");
      expect(screen.visible().join("\n")).toContain("Completed");
    } finally {
      screen.output.off("resize", region.resized);
      region.stop();
      screen.dispose();
    }
  });
});
