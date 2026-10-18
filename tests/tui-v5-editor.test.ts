import { describe, expect, it } from "vitest";
import { EditorController } from "../src/tui/editor-input.js";
import { EditorDocument, editorFrame } from "../src/tui/editor.js";
import { slashSuggestions } from "../src/tui/slash.js";
import { terminalHarness } from "./helpers/terminal.js";

const cmds = [
  { value: "help", label: "/help" },
  { value: "review", label: "/review" },
  { value: "gitdiff", label: "/gitdiff" },
  { value: "gitstatus", label: "/gitstatus" },
];

describe("default TUI inline slash completion", () => {
  it("filters registered commands only, excludes prose, and keeps every match", () => {
    expect(slashSuggestions("/gi", 3, cmds).map(item => item.value)).toEqual(["gitdiff", "gitstatus"]);
    expect(slashSuggestions("read /gi", 8, cmds)).toEqual([]);
    expect(slashSuggestions("/gi extra", 3, cmds)).toEqual([]);
    expect(slashSuggestions("/gi", 1, cmds)).toEqual([]);
    expect(slashSuggestions("/gi", 3, Array.from({length:20}, (_,i) => ({
      value: `gi${i}`, label: "test",
    })))).toHaveLength(20);
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

  it("Tab accepts a command and the next Enter dispatches the exact completed name", () => {
    const {ctl,submitted,written} = make();
    ctl.receive(Buffer.from("/gi"));
    expect(written.join("")).toContain("/gitdiff");
    ctl.receive(Buffer.from("\t\r"));
    expect(submitted).toEqual(["/gitdiff"]);
  });

  it("keeps direct Enter dispatch for a command already typed in full", () => {
    const { ctl, submitted } = make();
    ctl.receive(Buffer.from("/help\r"));
    expect(submitted).toEqual(["/help"]);
  });

  it("arrow keys select suggestions, while Enter only completes and Escape preserves the draft", async () => {
    const {ctl,submitted} = make();
    ctl.receive(Buffer.from("/gi\u001b[B\r"));
    expect(ctl.document.text).toBe("/gitstatus");
    expect(submitted).toEqual([]);
    ctl.receive(Buffer.from("\r"));
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

  it("moves through all matches when the terminal can show a long menu", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      value: `go${index}`, label: `/go${index} · command ${index}`,
    }));
    const ctl = new EditorController({ columns: 40, rows: 24, write: () => {} }, () => {}, {
      submitOnEnter: true, slashCommands: many,
    });
    ctl.begin();
    ctl.receive(Buffer.from("/go" + "\u001b[B".repeat(17) + "\t"));
    expect(ctl.document.text).toBe("/go17");
    ctl.cancel();
  });

  it("cycles on split Shift+Tab without changing the draft or cursor", async () => {
    const written: string[] = [];
    let switches = 0;
    const ctl = new EditorController({ write: part => written.push(part), columns: 72, rows: 18 }, () => {}, {
      submitOnEnter: true,
      footerStatus: () => "└─ Ask for me · Shift+Tab Plan",
      onShiftTab: () => { switches += 1; },
    });
    ctl.begin();
    ctl.receive(Buffer.from("draft"));
    ctl.receive(Buffer.from("\u001b[D"));
    ctl.receive(Buffer.from("\u001b["));
    ctl.receive(Buffer.from("Z"));
    await Promise.resolve();
    expect(switches).toBe(1);
    expect(ctl.document.text).toBe("draft");
    expect(ctl.document.cursor).toBe(4);
    expect(written.join("")).toContain("Ask for me · Shift+Tab Plan");
  });

  it("does not cycle inside bracketed paste, history search, or the explicit modal editor", async () => {
    let switches = 0;
    const inline = new EditorController({ write: () => {}, columns: 72, rows: 18 }, () => {}, {
      submitOnEnter: true,
      onShiftTab: () => { switches += 1; },
    });
    inline.begin();
    inline.receive(Buffer.from("\u001b[200~\u001b[Zpaste\u001b[201~"));
    await new Promise(resolve => setImmediate(resolve));
    expect(switches).toBe(0);
    expect(inline.document.text).toContain("paste");
    inline.receive(Buffer.from("\u0012\u001b[Z"));
    await new Promise(resolve => setImmediate(resolve));
    expect(switches).toBe(0);
    inline.cancel();

    const modal = new EditorController({ write: () => {}, columns: 72, rows: 18 }, () => {}, {
      onShiftTab: () => { switches += 1; },
    });
    modal.begin();
    modal.receive(Buffer.from("\u001b[Z"));
    await new Promise(resolve => setImmediate(resolve));
    expect(switches).toBe(0);
    modal.cancel();
  });

  it("buffers typing and Enter until an asynchronous mode change finishes", async () => {
    let release!: () => void;
    const switching = new Promise<void>(resolve => { release = resolve; });
    const submitted: (string | undefined)[] = [];
    const written: string[] = [];
    let writtenAtSubmit = -1;
    const ctl = new EditorController({ write: part => written.push(part), columns: 72, rows: 18 }, value => {
      submitted.push(value);
      writtenAtSubmit = written.join("").length;
    }, {
      submitOnEnter: true,
      onShiftTab: () => switching,
    });
    ctl.begin();
    ctl.receive(Buffer.from("draft\u001b[Z"));
    ctl.receive(Buffer.from("+more\r"));
    expect(submitted).toEqual([]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(submitted).toEqual(["draft+more"]);
    expect(written.join("")).toHaveLength(writtenAtSubmit);
  });

  it("does not release the editor on Ctrl+C until the mode change settles", async () => {
    let release!: () => void;
    const switching = new Promise<void>(resolve => { release = resolve; });
    const submitted: (string | undefined)[] = [];
    const ctl = new EditorController({ write: () => {}, columns: 72, rows: 18 }, value => submitted.push(value), {
      submitOnEnter: true,
      onShiftTab: () => switching,
    });
    ctl.begin();
    ctl.receive(Buffer.from("draft\u001b[Z"));
    ctl.receive(Buffer.from("\u0003"));
    expect(submitted).toEqual([]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(submitted).toEqual([undefined]);
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
    const selection = editorFrame(doc, 50, 16);
    expect(selection.lines.join("\n")).toContain("\u001b[7m👩‍💻\u001b[0m");
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

  it("maps clicks through a horizontally scrolled viewport and its ellipsis", () => {
    const c = new EditorController({ columns: 20, rows: 12, write: () => {} }, () => {}, {
      submitOnEnter: true, mouse: true,
    });
    c.begin();
    c.receive(Buffer.from("abcdefghijklmnopqrstuvwxyz"));
    c.receive(Buffer.from("\u001b[12;4R"));
    // At width 20 the visible text starts with “…” then “n”; click the n.
    c.receive(Buffer.from("\u001b[<0;4;12M"));
    expect(c.document.position).toEqual({ row: 0, column: 13 });
    c.cancel();
  });

  it("uses each visible row's scroll mapping and treats Unicode by display cells", () => {
    const c = new EditorController({ columns: 20, rows: 12, write: () => {} }, () => {}, {
      submitOnEnter: true, mouse: true,
    });
    c.begin();
    c.receive(Buffer.from("abcdefghijkl👩‍💻xyz\u000fshort\u001b[A\u001b[F"));
    c.receive(Buffer.from("\u001b[12;4R"));
    // The first line is scrolled; the second line is not. Clicking column 5
    // on the second line must therefore map to its own column 2.
    c.receive(Buffer.from("\u001b[<0;5;13M"));
    expect(c.document.position).toEqual({ row: 1, column: 2 });
    c.cancel();
  });

  it("maps a Unicode grapheme through a scrolled viewport by display cells", () => {
    const c = new EditorController({ columns: 20, rows: 12, write: () => {} }, () => {}, {
      submitOnEnter: true, mouse: true,
    });
    c.begin();
    c.receive(Buffer.from("abcdefghijkl👩‍💻xyz"));
    c.receive(Buffer.from("\u001b[12;4R"));
    // The emoji starts at document display cell 12 and screen column 12.
    c.receive(Buffer.from("\u001b[<0;12;12M"));
    expect(c.document.position).toEqual({ row: 0, column: 12 });
    c.cancel();
  });

  it("clicking a visible slash suggestion completes it without submitting", () => {
    const submitted: (string | undefined)[] = [];
    const c = new EditorController({ columns: 30, rows: 10, write: () => {} }, value => submitted.push(value), {
      submitOnEnter: true, mouse: true, slashCommands: cmds,
    });
    c.begin();
    c.receive(Buffer.from("/gi"));
    c.receive(Buffer.from("\u001b[12;4R"));
    c.receive(Buffer.from("\u001b[<0;8;14M"));
    expect(c.document.text).toBe("/gitstatus");
    expect(submitted).toEqual([]);
    c.cancel();
  });

  it("uses wheel browsing only over visible menu rows and ignores off-screen clicks", () => {
    const c = new EditorController({ columns: 30, rows: 10, write: () => {} }, () => {}, {
      submitOnEnter: true, mouse: true, slashCommands: cmds,
    });
    c.begin();
    c.receive(Buffer.from("/gi"));
    c.receive(Buffer.from("\u001b[12;4R"));
    c.receive(Buffer.from("\u001b[<0;8;15M")); // footer is outside the menu
    expect(c.document.text).toBe("/gi");
    c.receive(Buffer.from("\u001b[<65;8;13M")); // wheel down over first visible candidate
    c.receive(Buffer.from("\u001b[<0;50;14M")); // outside terminal width
    expect(c.document.text).toBe("/gi");
    c.receive(Buffer.from("\t"));
    expect(c.document.text).toBe("/gitstatus");
    c.cancel();
  });

  it("renders suggestions without exceeding terminal height", () => {
    const doc = new EditorDocument();
    doc.insert("/gi");
    const frame = editorFrame(doc, 30, 9, true, [
      { value: "gitdiff", label: "/gitdiff · compare changes" },
      { value: "gitstatus", label: "/gitstatus · show status" },
    ], 1);
    expect(frame.lines.length).toBeLessThanOrEqual(9);
    expect(frame.lines.join("\n")).toContain("› /gitstatus · show status");
  });

  it("keeps a selection beyond the first page visible in a short terminal", () => {
    const doc = new EditorDocument();
    doc.insert("/go");
    const suggestions = Array.from({ length: 18 }, (_, index) => ({
      value: `go${index}`, label: `/go${index} · command ${index}`,
    }));
    const frame = editorFrame(doc, 32, 10, true, suggestions, 15);
    expect(frame.lines.length).toBeLessThanOrEqual(10);
    expect(frame.lines.join("\n")).toContain("› /go15 · command 15");
    expect(frame.suggestionRows?.map(item => item.commandIndex)).toEqual([13, 14, 15]);
  });

  it("does not redraw or invalidate DSR coordinates when the terminal reports position", () => {
    const out: string[] = [];
    const c = new EditorController({ columns: 30, rows: 10, write: part => out.push(part) }, () => {}, {
      submitOnEnter: true, mouse: true, slashCommands: cmds,
    });
    c.begin();
    c.receive(Buffer.from("/gi"));
    const afterPaint = out.join("");
    c.receive(Buffer.from("\u001b[12;"));
    c.receive(Buffer.from("4R"));
    expect(out.join("")).toBe(afterPaint);
    c.receive(Buffer.from("\u001b[<0;8;14M"));
    expect(c.document.text).toBe("/gitstatus");
    c.cancel();
  });

  it("requires a fresh position report after resize before menu clicks", () => {
    const c = new EditorController({ columns: 30, rows: 14, write: () => {} }, () => {}, {
      submitOnEnter: true, mouse: true, slashCommands: cmds,
    });
    c.begin();
    c.receive(Buffer.from("/gi\u001b[12;4R"));
    c.resized();
    c.receive(Buffer.from("\u001b[<0;8;14M")); // old DSR was invalidated
    expect(c.document.text).toBe("/gi");
    c.receive(Buffer.from("\u001b[12;4R"));
    c.receive(Buffer.from("\u001b[<0;8;14M"));
    expect(c.document.text).toBe("/gitstatus");
    c.cancel();
  });

  it("redraws a long menu within the new screen height after resize", async () => {
    const screen = terminalHarness(40, 24);
    const many = Array.from({ length: 20 }, (_, index) => ({
      value: `go${index}`, label: `/go${index} · command ${index}`,
    }));
    const c = new EditorController(screen.output, () => {}, { submitOnEnter: true, slashCommands: many });
    try {
      c.begin();
      c.receive(Buffer.from("/go" + "\u001b[B".repeat(17)));
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("/go17");
      screen.resize(32, 10);
      c.resized();
      await screen.flush();
      expect(screen.visible()).toHaveLength(10);
      expect(screen.visible().join("\n")).toContain("/go17");
      expect(screen.visible().join("\n")).toContain("↑↓ choose");
    } finally {
      c.cancel();
      screen.dispose();
    }
  });

  it("keeps the inline prompt quiet while the explicit editor keeps its instructions", () => {
    const doc = new EditorDocument();
    doc.insert("draft");
    const inline = editorFrame(doc, 40, 12, true, [], 0, "Ask for me · Shift+Tab Plan · /help");
    expect(inline.lines.join("\n")).toContain("› draft");
    expect(inline.lines.join("\n")).toContain("Ask for me · Shift+Tab Plan · /help");
    expect(inline.lines.join("\n")).not.toContain("Enter send");
    const modal = editorFrame(doc, 40, 12, false);
    expect(modal.lines.join("\n")).toContain("Ctrl+S send · Esc cancel · Enter ne…");
  });
});
