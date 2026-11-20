import { describe, expect, it } from "vitest";
import { EditorController } from "../src/tui/editor-input.js";
import { EditorDocument, editorFrame } from "../src/tui/editor.js";
import { displayWidth } from "../src/tui/text.js";
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
    }, value => submitted.push(value), { slashCommands: cmds });
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
      slashCommands: many,
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

  it("does not cycle inside bracketed paste", async () => {
    let switches = 0;
    const inline = new EditorController({ write: () => {}, columns: 72, rows: 18 }, () => {}, {
      onShiftTab: () => { switches += 1; },
    });
    inline.begin();
    inline.receive(Buffer.from("\u001b[200~\u001b[Zpaste\u001b[201~"));
    await new Promise(resolve => setImmediate(resolve));
    expect(switches).toBe(0);
    expect(inline.document.text).toContain("paste");
    inline.cancel();
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

describe("composer frame and footer layout", () => {
  it("renders suggestions without exceeding terminal height", () => {
    const doc = new EditorDocument();
    doc.insert("/gi");
    const frame = editorFrame(doc, 30, 9, {
      suggestions: [
        { value: "gitdiff", label: "/gitdiff · compare changes" },
        { value: "gitstatus", label: "/gitstatus · show status" },
      ],
      selectedSuggestion: 1,
    });
    expect(frame.lines.length).toBeLessThanOrEqual(9);
    expect(frame.lines.join("\n")).toContain("› /gitstatus · show status");
  });

  it("keeps a selection beyond the first page visible in a short terminal", () => {
    const doc = new EditorDocument();
    doc.insert("/go");
    const suggestions = Array.from({ length: 18 }, (_, index) => ({
      value: `go${index}`, label: `/go${index} · command ${index}`,
    }));
    const frame = editorFrame(doc, 32, 10, { suggestions, selectedSuggestion: 15 });
    expect(frame.lines.length).toBeLessThanOrEqual(10);
    expect(frame.lines.join("\n")).toContain("› /go15 · command 15");
  });

  it("redraws a long menu within the new screen height after resize", async () => {
    const screen = terminalHarness(40, 24);
    const many = Array.from({ length: 20 }, (_, index) => ({
      value: `go${index}`, label: `/go${index} · command ${index}`,
    }));
    const c = new EditorController(screen.output, () => {}, { slashCommands: many });
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

  it("keeps the inline prompt quiet and shows the footer status", () => {
    const doc = new EditorDocument();
    doc.insert("draft");
    const inline = editorFrame(doc, 40, 12, { footerStatus: "Ask for me · Shift+Tab Plan · /help" });
    expect(inline.lines.join("\n")).toContain("› draft");
    expect(inline.lines.join("\n")).toContain("Ask for me · Shift+Tab Plan · /help");
    expect(inline.lines.join("\n")).not.toContain("Enter send");
  });

  it("draws an empty inline draft inside a rounded box and does not treat the placeholder as text", () => {
    const doc = new EditorDocument();
    const frame = editorFrame(doc, 60, 12, { footerStatus: "Ask for me · Shift+Tab Plan · /help" });
    const lines = frame.lines.join("\n");
    expect(lines).toContain("╭");
    expect(lines).toContain("╯");
    expect(lines).toContain("Ask chivgent to do anything");
    expect(lines).toContain("Ask for me · Shift+Tab Plan · /help");
    expect(doc.text).toBe("");
    expect(frame.lines.every(line => displayWidth(line) <= 59)).toBe(true);
    const drafted = new EditorDocument();
    drafted.insert("draft");
    expect(editorFrame(drafted, 60, 12).lines.join("\n")).not.toContain("Ask chivgent to do anything");
    const narrow = editorFrame(new EditorDocument(), 8, 6);
    expect(narrow.lines[0]).toMatch(/^╭.*╮$/);
    expect(narrow.lines.every(line => displayWidth(line) <= 7)).toBe(true);
    const colored = editorFrame(new EditorDocument(), 60, 12, { color: true });
    expect(colored.lines.join("\n")).toContain("\u001b[2mAsk chivgent to do anything\u001b[0m");
    expect(colored.lines[0]).toContain("\u001b[2m╭");
    expect(colored.lines.join("\n")).toContain("\u001b[1;36m›\u001b[0m");
    expect(colored.cursorColumn).toBe(frame.cursorColumn);
    expect(editorFrame(new EditorDocument(), 60, 12).lines.join("\n")).not.toContain("\u001b[");
  });

  const modeHint = "Ask for me · Shift+Tab Plan · /help";

  it("shows the provider and model under the composer and right-aligns the mode hint", () => {
    const doc = new EditorDocument();
    const frame = editorFrame(doc, 80, 12, { footerStatus: modeHint, footerIdentity: "openai · gpt-test" });
    const footer = frame.lines.at(-1) ?? "";
    expect(footer.startsWith("openai · gpt-test")).toBe(true);
    expect(footer.endsWith(modeHint)).toBe(true);
    expect(displayWidth(footer)).toBe(79);
    expect(frame.lines.join("\n")).toContain("Ask chivgent to do anything");
    expect(doc.text).toBe("");
    expect(footer).not.toContain("\u001b[");

    const coloredFooter = editorFrame(doc, 80, 12, {
      footerStatus: modeHint,
      color: true,
      footerIdentity: "openai · gpt-test",
    }).lines.at(-1) ?? "";
    expect(coloredFooter).toContain(`\u001b[2m${modeHint}\u001b[0m`);
    expect(displayWidth(coloredFooter)).toBe(79);
  });

  it("keeps the mode hint when the model name does not fit", () => {
    const identity = `openai · ${"m".repeat(180)}`;
    const normal = editorFrame(new EditorDocument(), 80, 12, { footerStatus: modeHint, footerIdentity: identity }).lines.at(-1) ?? "";
    expect(normal.startsWith("openai")).toBe(true);
    expect(normal.endsWith(modeHint)).toBe(true);
    expect(normal).toContain("…");
    expect(normal).not.toContain("m".repeat(180));
    expect(displayWidth(normal)).toBeLessThanOrEqual(79);
    const narrow = editorFrame(new EditorDocument(), 40, 12, { footerStatus: modeHint, footerIdentity: identity }).lines.at(-1) ?? "";
    expect(narrow.endsWith(modeHint)).toBe(true);
    expect(narrow).not.toContain("m".repeat(40));
    expect(displayWidth(narrow)).toBeLessThanOrEqual(39);
  });

  it("strips control characters from the footer provider and model", () => {
    const footer = editorFrame(new EditorDocument(), 80, 12, {
      footerStatus: modeHint,
      footerIdentity: "openai · \u001b[2Jgpt-test",
    }).lines.at(-1) ?? "";
    expect(footer).toContain("openai · gpt-test");
    expect(footer.endsWith(modeHint)).toBe(true);
    expect(footer).not.toContain("\u001b[");
  });

  it("does not invent a model on the footer when none is active", () => {
    const footer = editorFrame(new EditorDocument(), 80, 12, { footerStatus: modeHint }).lines.at(-1) ?? "";
    expect(footer).toBe(modeHint);
    expect(footer).not.toContain("unknown model");
  });

  it("keeps the command hint in place of the model while the menu is open", () => {
    const doc = new EditorDocument();
    doc.insert("/he");
    const footer = editorFrame(doc, 60, 12, {
      suggestions: [{ value: "help", label: "/help" }],
      selectedSuggestion: 0,
      footerStatus: modeHint,
      footerIdentity: "openai · gpt-test",
    }).lines.at(-1) ?? "";
    expect(footer).toContain("↑↓ choose");
    expect(footer).not.toContain("gpt-test");
  });
});
