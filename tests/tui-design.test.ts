import { describe, expect, it } from "vitest";
import { toolTranscript, approvalPreview, commandReviewable, colorizeActivity } from "../src/tui/activity.js";
import { EMPTY_STATE, reduce } from "../src/tui/state.js";
import { view } from "../src/tui/view.js";
import type { TurnEndEvent } from "../src/events.js";

function patchEvent(): TurnEndEvent {
  return {
    type: "turn_end", turn: 1,
    message: {
      role: "assistant", content: "Renamed the helpers.", toolCalls: [{
        id: "p1", name: "apply_patch",
        arguments: { patch: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "@@", "-old", "+new", " keep",
          "*** Add File: src/b.ts", "+export const b = true;",
          "*** Delete File: src/deprecated.ts",
          "*** End Patch",
        ].join("\n") },
      }],
    },
    toolResults: [
      { role: "tool", toolCallId: "p1", toolName: "apply_patch", content: "Patch applied", isError: false },
    ],
  };
}

describe("TUI activity presentation", () => {
  it("shows a bounded multi-file patch summary with per-file change counts", () => {
    const event = patchEvent();
    expect(toolTranscript(event.message.toolCalls, event.toolResults)).toEqual([
      "  ✓ Patched",
      "    3 files · +2/-1",
      "    ~ src/a.ts (+1/-1)",
      "    + src/b.ts (new file, +1)",
      "    - src/deprecated.ts (deleted)",
      "      -old",
      "      +new",
      "      +export const b = true;",
    ]);
  });

  it("never shows a successful-looking patch diff when the patch failed", () => {
    const event = patchEvent();
    const summary = toolTranscript(event.message.toolCalls, [{
      ...event.toolResults[0]!, isError: true,
      content: "Patch context not found in src/a.ts\nDo not execute",
    }]);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("! Patched");
    expect(summary[0]).toContain("context not found");
    expect(summary.join("\n")).not.toContain("3 files");
  });

  it("highlights a useful final shell result without printing the whole test log", () => {
    const calls = [{ id: "shell-1", name: "bash", arguments: { command: "npm test" } }];
    const result = [{
      role: "tool" as const, toolCallId: "shell-1", toolName: "bash",
      content: "setup\nwarning text\n42 tests passed\n", isError: false,
    }];
    expect(toolTranscript(calls, result)).toEqual([
      "  ✓ Shell npm test",
      "    ↳ 42 tests passed",
    ]);
    expect(toolTranscript(calls, [{
      ...result[0]!, content: "stacktrace\nCommand exited with code 1", isError: true,
    }])).toEqual([
      "  ! Shell npm test — Command exited with code 1",
    ]);
  });

  it("groups consecutive successful reads but exposes failures individually", () => {
    const calls = ["a", "b", "c"].map(id => ({
      id, name: "read_file", arguments: { path: `src/${id}.ts` },
    }));
    const results = calls.map(call => ({
      role: "tool" as const, toolCallId: call.id,
      toolName: call.name, content: "ok", isError: false,
    }));
    expect(toolTranscript(calls, results)).toEqual(["  ✓ Explored 3 locations"]);
    expect(toolTranscript(calls, [
      results[0]!, { ...results[1]!, isError: true, content: "File missing" }, results[2]!,
    ])).toEqual([
      "  ✓ Read src/a.ts",
      "  ! Read src/b.ts — File missing",
      "  ✓ Read src/c.ts",
    ]);
  });

  it("prevents terminal escape injection and respects NO_COLOR presentation", () => {
    const unsafe = "File missing\x1b[2J\r\nInjected\x07";
    const lines = ["  ! Read a.ts — " + unsafe, "  ✓ Read b.ts"];
    const plain = colorizeActivity(lines, false);
    expect(plain).not.toContain("\x1b");
    expect(plain).not.toContain("\x07");
    expect(colorizeActivity(lines, true)).toContain("\x1b[31m");
    expect(colorizeActivity(lines, true)).toContain("\x1b[32m");
    expect(colorizeActivity(lines, true)).not.toContain("\x1b[2J");
  });

  it("keeps a command's full contents reviewable or refuses to ask for approval", () => {
    expect(commandReviewable("npm test", 80)).toBe(true);
    expect(commandReviewable("echo \x1b[2J hidden", 80)).toBe(false);
    expect(commandReviewable("x".repeat(500), 80)).toBe(false);
    expect(commandReviewable("echo ok\n".repeat(9), 80)).toBe(false);
    const preview = approvalPreview("echo ok\n".repeat(9), 50);
    expect(preview).toContain("more lines hidden");
    for (const line of preview.trim().split("\n")) {
      expect(line.length).toBeLessThan(55);
    }
  });

  it("shows completed tool counts and failures without hiding the stop shortcut", () => {
    let state = reduce(EMPTY_STATE, { type: "agent_start", prompt: "x", maxTurns: 4 }, 1_000);
    state = reduce(state, {
      type: "tool_execution_start", turn: 1, toolCallId: "one",
      toolName: "read_file", arguments: { path: "src/a.ts" },
    }, 1_000);
    state = reduce(state, {
      type: "tool_execution_end", turn: 1, toolCallId: "one",
      toolName: "read_file", content: "Failed", isError: true,
    }, 2_000);
    expect(state.run?.completedTools).toBe(1);
    expect(state.run?.failedTools).toBe(1);
    expect(view(state, { width: 110, now: 3_000 }).at(-1)).toContain("0 ok, 1 failed");
    expect(view(state, { width: 20, now: 3_000 }).at(-1)).toContain("^C");
  });
});
