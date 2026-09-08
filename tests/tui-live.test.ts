import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { createLiveRegion } from "../src/tui/live.js";

const CLEAR_LINE = "\u001B[2K";

function recorder() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => void chunks.push(chunk) },
    written: () => chunks.join(""),
  };
}

function live(output: ReturnType<typeof recorder>, now = () => 1_000) {
  return createLiveRegion({ stream: output.stream, width: () => 80, now });
}

const start: AgentEvent = { type: "agent_start", prompt: "go", maxTurns: 8 };

const turnEnd: AgentEvent = {
  type: "turn_end",
  turn: 1,
  message: {
    role: "assistant",
    content: "the answer",
    toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }],
  },
  toolResults: [
    { role: "tool", toolCallId: "1", toolName: "read_file", content: "x", isError: false },
  ],
};

describe("createLiveRegion", () => {
  it("draws the region once a run begins", () => {
    const output = recorder();
    const region = live(output);

    region.listener(start);

    expect(output.written()).toContain("thinking");
    region.stop();
  });

  it("erases the region before flushing a finished turn to scrollback", () => {
    // Order matters: writing the transcript first would push it below a region
    // that is then erased from the wrong place, leaving both in the wrong spot.
    const output = recorder();
    const region = live(output);
    region.listener(start);
    output.chunks.length = 0;

    region.listener(turnEnd);

    const written = output.written();
    const erased = written.indexOf(CLEAR_LINE);
    const flushed = written.indexOf("  read_file a.ts");
    expect(erased).toBeGreaterThanOrEqual(0);
    expect(flushed).toBeGreaterThan(erased);
    expect(written).toContain("the answer");
    region.stop();
  });

  it("leaves nothing on screen when the run ends", () => {
    const output = recorder();
    const region = live(output);
    region.listener(start);
    output.chunks.length = 0;

    region.listener({
      type: "agent_end",
      status: "completed",
      turnCount: 1,
      messages: [],
    });

    // Erased, and nothing drawn in its place.
    expect(output.written()).toContain(CLEAR_LINE);
    expect(output.written()).not.toContain("thinking");
  });

  it("clears the region when a run is cancelled, not only when it completes", () => {
    // Ctrl+C reports `aborted` rather than throwing; a region left behind
    // would read as output belonging to the shell.
    const output = recorder();
    const region = live(output);
    region.listener(start);
    output.chunks.length = 0;

    region.listener({
      type: "agent_end",
      status: "aborted",
      turnCount: 1,
      messages: [],
    });

    expect(output.written()).toContain(CLEAR_LINE);
    expect(output.written()).not.toContain("thinking");
  });

  it("advances elapsed time on its own, with no events arriving", async () => {
    let now = 1_000;
    const output = recorder();
    const region = createLiveRegion({
      stream: output.stream,
      width: () => 80,
      now: () => now,
      tickMs: 5,
    });
    region.listener(start);
    output.chunks.length = 0;

    now = 4_000;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(output.written()).toContain("3s");
    region.stop();
  });

  it("stops the clock when the run does", async () => {
    let now = 1_000;
    const output = recorder();
    const region = createLiveRegion({
      stream: output.stream,
      width: () => 80,
      now: () => now,
      tickMs: 5,
    });
    region.listener(start);
    region.listener({
      type: "agent_end",
      status: "completed",
      turnCount: 1,
      messages: [],
    });
    output.chunks.length = 0;

    now = 9_000;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(output.chunks).toEqual([]);
  });

  it("is safe to stop twice", () => {
    const output = recorder();
    const region = live(output);
    region.listener(start);
    region.stop();
    output.chunks.length = 0;

    region.stop();

    expect(output.chunks).toEqual([]);
  });
});
