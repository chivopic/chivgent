import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { Message } from "../src/messages.js";
import { DIFF_PAGE_LINES, mostRecentSuccessfulPatch, formatDiffPage } from "../src/tui/diff.js";
import { formatTerminalMarkdown } from "../src/tui/markdown.js";
import { createLiveRegion } from "../src/tui/live.js";

describe("paginated patch review", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/main.ts", "@@", "-old", "+new", "*** End Patch"].join("\n");
  const history: Message[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "same", name: "apply_patch", arguments: { patch } }] },
    { role: "tool", toolCallId: "same", toolName: "apply_patch", isError: false, content: "Patch applied" },
  ];

  it("shows only the newest successful patch and never a failed one", () => {
    expect(mostRecentSuccessfulPatch(history)).toBe(patch);
    const failed = [
      ...history,
      { role: "assistant" as const, content: "", toolCalls: [{ id: "same", name: "apply_patch", arguments: { patch: "BAD PATCH" } }] },
      { role: "tool" as const, toolCallId: "same", toolName: "apply_patch", isError: true, content: "Context mismatch" },
    ];
    expect(mostRecentSuccessfulPatch(failed)).toBe(patch);
    expect(mostRecentSuccessfulPatch(failed.slice(2))).toBeUndefined();
  });

  it("paginates large diffs, preserving all source lines without executing a pager", () => {
    const lines = Array.from({ length: DIFF_PAGE_LINES * 2 + 5 }, (_, i) => `+line-${i}`);
    const page1 = formatDiffPage(lines.join("\n"), 1, 45);
    const page2 = formatDiffPage(lines.join("\n"), 2, 45);
    const page3 = formatDiffPage(lines.join("\n"), 3, 45);
    expect(page1.pageCount).toBe(3);
    expect(page1.text).toContain("/diff 2");
    expect(page2.text).toContain("line-28");
    expect(page3.text).toContain("End of patch");
    expect(page1.text).not.toContain("line-60");
    expect(page2.text).not.toContain("line-60");
    expect(page3.text).toContain("line-60");
  });

  it("sanitizes terminal escape sequences and respects small widths", () => {
    const rendered = formatDiffPage("+good\x1b[2J\n-中文字符串👩‍💻", 1, 18, true).text;
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).toContain("\x1b[32m");
    expect(rendered).toContain("\x1b[31m");
    const plain = formatDiffPage("+ok", 1, 20, false).text;
    expect(plain).not.toContain("\x1b");
  });
});

describe("terminal Markdown", () => {
  const markdown = [
    "# Overview",
    "",
    "- one",
    "- two",
    "",
    "> important",
    "",
    "```ts",
    "const text = '<script>not markup</script>';",
    "console.log(text);",
    "```",
  ].join("\n");

  it("uses an accessible text layout for headings, lists, quotes and fenced code", () => {
    const output = formatTerminalMarkdown(markdown, 65);
    expect(output).toContain("Overview");
    expect(output).toContain("• one");
    expect(output).toContain("┃ important");
    expect(output).toContain("┌─ ts");
    expect(output).toContain("│ const text");
    expect(output).toContain("└─");
    expect(output).not.toContain("```");
  });

  it("does not allow code blocks to inject terminal controls or wrap unexpectedly", () => {
    const output = formatTerminalMarkdown("# Head\n```js\n\x1b[2J" + "a".repeat(150) + "\n```", 22, true);
    expect(output).not.toContain("\x1b[2J");
    expect(output).toContain("\x1b[36m");
    for (const line of output.split("\n")) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain.length).toBeLessThanOrEqual(22);
    }
  });

  it("changes the final answer only when Markdown is explicitly enabled", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const region = createLiveRegion({
      stream: { write: (chunk) => stderr.push(chunk) },
      answerStream: { write: (chunk) => stdout.push(chunk) },
      width: () => 80, markdown: true, color: false,
    });
    try {
      region.listener({ type: "agent_start", prompt: "test", maxTurns: 2 });
      region.listener({
        type: "turn_end", turn: 1,
        message: { role: "assistant", content: "## Result\n- pass", toolCalls: [] },
        toolResults: [],
      });
      region.listener({ type: "agent_end", status: "completed", turnCount: 1, messages: [] });
      expect(stdout.join("")).toContain("• pass");
      expect(stdout.join("")).not.toContain("## Result");
    } finally { region.stop(); }
  });
});
