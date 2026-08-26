import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { createEventRenderer, type RendererOptions } from "../src/render.js";

function render(
  events: readonly AgentEvent[],
  options: RendererOptions = {},
): { readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const listener = createEventRenderer(
    {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    },
    options,
  );
  for (const event of events) {
    listener(event);
  }
  return { stdout, stderr };
}

const finalMessage = {
  role: "assistant",
  content: "Hello world",
  toolCalls: [],
} as const;

describe("event renderer", () => {
  it("writes streamed deltas to stdout and ends the line once", () => {
    const output = render([
      { type: "message_update", turn: 1, delta: "Hello" },
      { type: "message_update", turn: 1, delta: " world" },
      { type: "message_end", turn: 1, message: finalMessage },
      {
        type: "agent_end",
        status: "completed",
        turnCount: 1,
        messages: [],
      },
    ]);

    expect(output.stdout).toBe("Hello world\n");
    expect(output.stderr).toBe("");
  });

  it("writes the whole message once when streaming is off", () => {
    const output = render(
      [
        { type: "message_update", turn: 1, delta: "ignored" },
        { type: "message_end", turn: 1, message: finalMessage },
      ],
      { stream: false },
    );

    expect(output.stdout).toBe("Hello world\n");
  });

  it("summarises tool activity on stderr", () => {
    const output = render([
      {
        type: "tool_execution_start",
        turn: 1,
        toolCallId: "call-1",
        toolName: "read_file",
        arguments: { path: "src/agent.ts", start_line: 1 },
      },
      {
        type: "tool_execution_end",
        turn: 1,
        toolCallId: "call-1",
        toolName: "read_file",
        content: "File: src/agent.ts\n---\nline one\nline two",
        isError: false,
      },
    ]);

    expect(output.stdout).toBe("");
    expect(output.stderr).toBe(
      '· read_file {"path":"src/agent.ts","start_line":1}\n' +
        "  ↳ File: src/agent.ts (4 lines)\n",
    );
  });

  it("hides tool activity when asked", () => {
    const output = render(
      [
        {
          type: "tool_execution_start",
          turn: 1,
          toolCallId: "call-1",
          toolName: "read_file",
          arguments: {},
        },
      ],
      { showToolActivity: false },
    );

    expect(output.stderr).toBe("");
  });

  it("marks tool errors", () => {
    const output = render([
      {
        type: "tool_execution_end",
        turn: 1,
        toolCallId: "call-1",
        toolName: "read_file",
        content: "File not found: missing.ts",
        isError: true,
      },
    ]);

    expect(output.stderr).toBe("  ↳ error: File not found: missing.ts\n");
  });

  it("closes an unterminated streamed line before a status note", () => {
    const output = render([
      { type: "message_update", turn: 1, delta: "Partial" },
      {
        type: "agent_end",
        status: "aborted",
        turnCount: 1,
        messages: [],
      },
    ]);

    expect(output.stdout).toBe("Partial\n");
    expect(output.stderr).toBe("Interrupted.\n");
  });

  it("reports a turn limit on stderr", () => {
    expect(
      render([
        { type: "agent_end", status: "max_turns", turnCount: 8, messages: [] },
      ]).stderr,
    ).toBe("Stopped after 8 turns without a final answer.\n");
  });

  it("leaves a failed run to the caller that awaited it", () => {
    const output = render([
      {
        type: "agent_end",
        status: "error",
        turnCount: 2,
        messages: [],
        error: "Provider unavailable",
      },
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toBe("");
  });
});
