import { describe, expect, it } from "vitest";
import { EditorController } from "../src/tui/editor-input.js";
import { EditorDocument, editorFrame } from "../src/tui/editor.js";
import { slashSuggestions } from "../src/tui/slash.js";

const cmds = [
  { value: "help", label: "/help" },
  { value: "review", label: "/review" },
  { value: "gitdiff", label: "/gitdiff" },
  { value: "gitstatus", label: "/gitstatus" },
];

describe("default TUI inline slash completion", () => {
  it("filters registered commands only, excludes prose and caps the result count", () => {
    expect(slashSuggestions("/gi", 3, cmds).map(item => item.value)).toEqual(["gitdiff", "gitstatus"]);
    expect(slashSuggestions("read /gi", 8, cmds)).toEqual([]);
    expect(slashSuggestions("/gi extra", 3, cmds)).toEqual([]);
    expect(slashSuggestions("/gi", 1, cmds)).toEqual([]);
    expect(slashSuggestions("/gi", 3, Array.from({length:20}, (_,i) => ({
      value: `gi${i}`, label: "test",
    })))).toHaveLength(5);
  });

  function make() {
    const written: string[] = [];
    const submitted: (string | undefined)[] = [];
    const ctl = new EditorController({
      write: part => written.push(part), columns: 72, rows: 18,
    }, value => submitted.push(value), { submitOnEnter: true, slashCommands: cmds });
    ctl.begin();
    return { ctl, written, submitted };
  }

  it("Tab accepts a command and Enter dispatches the exact completed name", () => {
    const {ctl,submitted,written} = make();
    ctl.receive(Buffer.from("/gi"));
    expect(written.join("")).toContain("/gitdiff");
    ctl.receive(Buffer.from("\t\r"));
    expect(submitted).toEqual(["/gitdiff"]);
  });

  it("arrow keys select suggestions, but Escape dismisses rather than discards the draft", async () => {
    const {ctl,submitted} = make();
    ctl.receive(Buffer.from("/gi\u001b[B\t\r"));
    expect(submitted).toEqual(["/gitstatus"]);
    const second = make();
    second.ctl.receive(Buffer.from("/re"));
    second.ctl.receive(Buffer.from("\u001b"));
    await new Promise(resolve => setTimeout(resolve, 80));
    second.ctl.receive(Buffer.from("\r"));
    expect(second.submitted).toEqual(["/re"]);
  });

  it("never autocompletes unknown slash text into a different authorized command", () => {
    const {ctl,submitted} = make();
    ctl.receive(Buffer.from("/do-not-run\r"));
    expect(submitted).toEqual(["/do-not-run"]);
  });
});

describe("mouse caret and selected text", () => {
  it("places the caret on grapheme boundaries and replaces a drag selection", () => {
    const doc = new EditorDocument();
    doc.insert("a👩‍💻b\nsecond");
    doc.placeAt(0, 1);
    expect(doc.cursor).toBe(1);
    doc.placeAt(0, 3, true);
    expect(doc.selectionRange()).toEqual({ start: 1, end: 6 });
    doc.insert("X");
    expect(doc.text).toBe("aXb\nsecond");
  });

  it("hit tests reported SGR mouse coordinates only after terminal DSR resolves", () => {
    const out: string[] = [];
    const c = new EditorController({
      columns: 80, rows: 24, write: part => out.push(part),
    }, () => {}, { submitOnEnter: true, mouse: true });
    c.begin();
    c.receive(Buffer.from("one\u000ftwo")); // Ctrl+O inserts a line; plain LF submits
    // Simulated DSR cursor is at screen row 12. Caret is on the second input row.
    c.receive(Buffer.from("\u001b[12;6R"));
    // First editable line is at screen row 11, column 3 starts text.
    c.receive(Buffer.from("\u001b[<0;3;11M"));
    expect(c.document.position).toEqual({row:0,column:0});
    c.receive(Buffer.from("\u001b[<32;5;11M"));
    expect(c.document.selectionRange()).toEqual({start:0,end:2});
    c.receive(Buffer.from("\u001b[<0;5;11m"));
    c.receive(Buffer.from("X"));
    expect(c.document.text).toBe("Xe\ntwo");
    c.cancel();
    expect(out.join("")).toContain("\u001b[?1000h");
    expect(out.join("")).toContain("\u001b[?1000l");
  });

  it("renders suggestions without exceeding terminal height", () => {
    const doc = new EditorDocument();
    doc.insert("/gi");
    const frame = editorFrame(doc, 30, 9, true, ["gitdiff", "gitstatus"], 1);
    expect(frame.lines.length).toBeLessThanOrEqual(9);
    expect(frame.lines.join("\n")).toContain("› /gitstatus");
  });
});
