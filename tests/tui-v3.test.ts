import { describe, expect, it } from "vitest";
import { highlightCodeLine } from "../src/tui/syntax.js";
import { formatTerminalMarkdown } from "../src/tui/markdown.js";
import { PatchReviewController, reviewFrame } from "../src/tui/review.js";
import { displayWidth } from "../src/tui/text.js";
import { terminalHarness } from "./helpers/terminal.js";

describe("language-aware terminal syntax", () => {
  it("colors keywords, strings, comments and numbers, not arbitrary identifiers", () => {
    const output = highlightCodeLine('const x = "hi"; // note 123', "ts");
    expect(output).toContain("\u001b[94mconst\u001b[0m");
    expect(output).toContain('\u001b[32m"hi"\u001b[0m');
    expect(output).toContain("\u001b[2m// note 123\u001b[0m");
    expect(output).toContain("x");
    expect(highlightCodeLine("const x = 1;", "unknown")).toBe("const x = 1;");
  });

  it("never renders untrusted terminal erase sequences", () => {
    const rendered = formatTerminalMarkdown(
      "```python\nprint('hello')\x1b[2J\n```",
      80,
      true,
    );
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).toContain("┌─ python");
    expect(rendered).toContain("\u001b[94mprint\u001b[0m");
  });
});

describe("interactive Diff Review", () => {
  const patch = [
    "*** Begin Patch", "*** Update File: src/a.ts", "@@",
    ...Array.from({ length: 52 }, (_, i) => i % 2 === 0 ? `-old${i}` : `+new${i}`),
    "*** End Patch",
  ].join("\n");

  it("fits the available terminal area and colors changes without wrap", () => {
    const frame = reviewFrame(patch, 1, 40, 13, true);
    expect(frame.pageCount).toBeGreaterThan(2);
    expect(frame.lines.length).toBeLessThanOrEqual(10);
    expect(frame.lines.join("\n")).toContain("\u001b[31m");
    expect(frame.lines.join("\n")).toContain("\u001b[32m");
    expect(frame.lines.every(line =>
      displayWidth(line.replace(/\u001b\[[0-9;]*m/g, "")) <= 39)).toBe(true);
  });

  it("uses arrow/page keys, cleans up its screen and returns to caller", async () => {
    const screen = terminalHarness(42, 14);
    let finished = 0;
    const review = new PatchReviewController(screen.output, patch, () => { finished += 1; });
    try {
      review.begin();
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("Patch review");
      review.receive(Buffer.from("\u001b[B"));
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("page 2/");
      review.receive(Buffer.from("p"));
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("page 1/");
      review.receive(Buffer.from("q"));
      await screen.flush();
      expect(finished).toBe(1);
      review.receive(Buffer.from("q"));
      expect(finished).toBe(1);
      screen.output.write("shell$ ");
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("shell$ ");
    } finally { review.cancel(); screen.dispose(); }
  });
});
