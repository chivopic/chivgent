import { describe, expect, it } from "vitest";
import { EditorDocument, editorFrame } from "../src/tui/editor.js";
import { EditorController } from "../src/tui/editor-input.js";
import { displayWidth } from "../src/tui/text.js";

describe("cursor-addressable editor document", () => {
  it("edits existing lines at the caret rather than appending new lines", () => {
    const editor = new EditorDocument();
    editor.insert("alpha\nbeta\ngamma");
    editor.moveVertical(-1);
    editor.home();
    editor.insert("NEW ");
    expect(editor.text).toBe("alpha\nNEW beta\ngamma");
    editor.backspace();
    expect(editor.text).toBe("alpha\nNEWbeta\ngamma");
    editor.delete();
    expect(editor.text).toBe("alpha\nNEWeta\ngamma");
    editor.end();
    editor.insert("\nthird");
    expect(editor.text).toContain("NEWeta\nthird");
  });

  it("never splits an emoji ZWJ or combining grapheme with Backspace and Delete", () => {
    const editor = new EditorDocument();
    editor.insert("a👩‍💻e\u0301b");
    editor.backspace();
    expect(editor.text).toBe("a👩‍💻e\u0301");
    editor.backspace();
    expect(editor.text).toBe("a👩‍💻");
    editor.backspace();
    expect(editor.text).toBe("a");
    editor.insert("👩‍💻x");
    editor.home();
    editor.right();
    editor.delete();
    expect(editor.text).toBe("ax");
  });

  it("moves vertically by visible terminal cells, preserving a preferred column", () => {
    const editor = new EditorDocument();
    editor.insert("中文abc\nx\n中文abc");
    editor.moveVertical(-1);
    expect(editor.position).toEqual({ row: 1, column: 1 });
    editor.moveVertical(-1);
    expect(editor.position).toEqual({ row: 0, column: 7 });
    editor.moveVertical(1);
    expect(editor.position).toEqual({ row: 1, column: 1 });
  });

  it("normalizes multiline CRLF input, rejects oversize drafts without mutation", () => {
    const editor = new EditorDocument();
    editor.insert("a\r\nb");
    expect(editor.text).toBe("a\nb");
    const original = editor.text;
    expect(editor.insert("x".repeat(70_000))).toBe(false);
    expect(editor.text).toBe(original);
    expect(editor.warning).toContain("Draft limit");
  });

  it("keeps caret visible in bounded narrow viewport without splitting Unicode", () => {
    const editor = new EditorDocument();
    editor.insert("old\n".repeat(11) + "last 😀 line " + "x".repeat(90));
    const frame = editorFrame(editor, 25, 10);
    expect(frame.lines.length).toBeLessThanOrEqual(7);
    expect(frame.cursorRow).toBeGreaterThan(0);
    expect(frame.cursorRow).toBeLessThan(frame.lines.length - 1);
    expect(frame.lines.every(line => displayWidth(line) <= 24)).toBe(true);
    expect(frame.lines.some(line => line.includes("…"))).toBe(true);
  });
});

describe("raw terminal editor events", () => {
  function harness() {
    const rendered: string[] = [];
    const commits: (string | undefined)[] = [];
    const controller = new EditorController({
      columns: 80, rows: 24, write: (value: string) => rendered.push(value),
    }, text => { commits.push(text); });
    controller.begin();
    return { controller, rendered, commits };
  }

  it("supports arrows, home, newlines, Ctrl+S and exact pasted text", () => {
    const { controller, commits } = harness();
    controller.receive(Buffer.from("first\rsecond\rthird"));
    controller.receive(Buffer.from("\u001b[A\u001b[H"));
    controller.receive(Buffer.from("NEW "));
    controller.receive(Buffer.from("\u0013"));
    expect(commits).toEqual(["first\nNEW second\nthird"]);
  });

  it("understands bracketed paste and escaped terminal controls", () => {
    const { controller, commits } = harness();
    controller.receive(Buffer.from("\u001b[200~hello\r\nline 2"));
    controller.receive(Buffer.from("\u001b[201~\u0013"));
    expect(commits).toEqual(["hello\nline 2"]);
  });

  it("Ctrl+C cancels the draft and stops processing queued keystrokes", () => {
    const { controller, commits } = harness();
    controller.receive(Buffer.from("SECRET\u0003\u0013"));
    expect(commits).toEqual([undefined]);
  });
});
