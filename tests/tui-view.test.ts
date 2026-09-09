import { describe, expect, it } from "vitest";
import type { TurnEndEvent } from "../src/events.js";
import { terminalWidth } from "../src/tui/live.js";
import { Painter } from "../src/tui/paint.js";
import { EMPTY_STATE, type ViewState } from "../src/tui/state.js";
import { transcriptLines, view } from "../src/tui/view.js";

const NOW = 100_000;
const CLEAR_LINE = "\u001B[2K";

function state(overrides: Partial<NonNullable<ViewState["run"]>> = {}): ViewState {
  return {
    run: {
      turn: 1,
      maxTurns: 8,
      startedAt: NOW - 3_000,
      text: "",
      running: [],
      status: "thinking",
      ...overrides,
    },
  };
}

/** Records every byte written, so a test can assert none were. */
function recorder() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => void chunks.push(chunk) },
    written: () => chunks.join(""),
  };
}

describe("view", () => {
  it("draws nothing between runs", () => {
    expect(view(EMPTY_STATE, { width: 80, now: NOW })).toEqual([]);
  });

  it("puts the status last, with elapsed time and the way out", () => {
    const lines = view(state(), { width: 80, now: NOW });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("thinking");
    expect(lines[0]).toContain("turn 1/8");
    expect(lines[0]).toContain("3s");
    expect(lines[0]).toContain("ctrl+c to stop");
  });

  it("shows the tail of the answer, not its head", () => {
    // What just arrived is what the reader wants; the beginning has already
    // scrolled past in their eyes.
    const lines = view(state({ text: "one\ntwo\nthree\nfour\nfive" }), {
      width: 80,
      now: NOW,
    });

    expect(lines.slice(0, 3)).toEqual(["three", "four", "five"]);
  });

  it("names each running tool, its target, and its newest output", () => {
    const lines = view(
      state({
        status: "running-tools",
        running: [
          {
            toolCallId: "a",
            name: "bash",
            target: "npm test",
            progress: "old line\nnewest line",
            startedAt: NOW - 2_000,
          },
        ],
      }),
      { width: 120, now: NOW },
    );

    expect(lines[0]).toContain("bash npm test");
    expect(lines[0]).toContain("(2s)");
    expect(lines[0]).toContain("newest line");
    expect(lines[0]).not.toContain("old line");
  });

  it("summarises the tools it cannot fit", () => {
    const running = ["a", "b", "c", "d", "e"].map((id) => ({
      toolCallId: id,
      name: "read_file",
      progress: "",
      startedAt: NOW,
    }));

    const lines = view(state({ status: "running-tools", running }), {
      width: 80,
      now: NOW,
    });

    expect(lines).toContain("  and 2 more");
  });

  it("marks a line it had to cut, so it never reads as whole", () => {
    const lines = view(state({ text: "x".repeat(200) }), { width: 40, now: NOW });

    expect(lines[0]).toHaveLength(40);
    expect(lines[0]?.endsWith("…")).toBe(true);
  });

  it("flags a total that is missing a turn", () => {
    const usage = {
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      complete: false,
    };

    expect(view(state({ usage }), { width: 120, now: NOW })[0]).toContain(
      "120 tokens+",
    );
  });
});

describe("terminalWidth", () => {
  it("falls back when the terminal reports no usable width", () => {
    // A pty can report 0 rather than nothing at all, which slips past a
    // nullish check and then collapses every line to the minimum.
    expect(terminalWidth({ columns: 0 })).toBe(80);
    expect(terminalWidth({})).toBe(80);
    expect(terminalWidth({ columns: 132 })).toBe(132);
  });
});

describe("transcriptLines", () => {
  const event: TurnEndEvent = {
    type: "turn_end",
    turn: 1,
    message: {
      role: "assistant",
      content: "Found it.",
      toolCalls: [
        { id: "1", name: "read_file", arguments: { path: "src/a.ts" } },
        { id: "2", name: "read_file", arguments: { path: "missing.ts" } },
      ],
    },
    toolResults: [
      { role: "tool", toolCallId: "1", toolName: "read_file", content: "x", isError: false },
      { role: "tool", toolCallId: "2", toolName: "read_file", content: "no", isError: true },
    ],
  };

  it("names the file each call was aimed at, joining result to call", () => {
    // A result carries no arguments, so "which file" is only recoverable
    // through the call id.
    expect(transcriptLines(event)).toEqual([
      "  read_file src/a.ts",
      "  read_file missing.ts (failed)",
      "Found it.",
    ]);
  });

  it("leaves out an empty answer rather than printing a blank line", () => {
    expect(
      transcriptLines({
        ...event,
        message: { ...event.message, content: "   " },
        toolResults: [],
      }),
    ).toEqual([]);
  });
});

describe("Painter", () => {
  it("writes nothing at all when the lines are unchanged", () => {
    const output = recorder();
    const painter = new Painter({ stream: output.stream });

    painter.render(["one", "two"]);
    output.chunks.length = 0;
    painter.render(["one", "two"]);

    expect(output.chunks).toEqual([]);
  });

  it("rewrites only the line that changed", () => {
    // The whole justification for line diffing: a ticking timer must not cost
    // a repaint of the block.
    const output = recorder();
    const painter = new Painter({ stream: output.stream });

    painter.render(["stable", "3s"]);
    output.chunks.length = 0;
    painter.render(["stable", "4s"]);

    const written = output.written();
    expect(written).toContain("4s");
    expect(written).not.toContain("stable");
  });

  it("erases the lines a shrinking region leaves behind", () => {
    const output = recorder();
    const painter = new Painter({ stream: output.stream });

    painter.render(["one", "two", "three"]);
    output.chunks.length = 0;
    painter.render(["one"]);

    // Two erases: one for each line the region no longer has.
    expect(output.written().split(CLEAR_LINE).length - 1).toBe(2);
  });

  it("repaints everything after the baseline is invalidated", () => {
    // A resize reflows what is on screen, so the previous array no longer
    // describes it and comparing against it would keep stale lines.
    const output = recorder();
    const painter = new Painter({ stream: output.stream });

    painter.render(["one", "two"]);
    painter.invalidate();
    output.chunks.length = 0;
    painter.render(["one", "two"]);

    expect(output.written()).toContain("one");
    expect(output.written()).toContain("two");
  });

  it("clears the region and then has nothing left to clear", () => {
    const output = recorder();
    const painter = new Painter({ stream: output.stream });

    painter.render(["one", "two"]);
    painter.clear();
    output.chunks.length = 0;
    painter.clear();

    expect(output.chunks).toEqual([]);
  });
});
