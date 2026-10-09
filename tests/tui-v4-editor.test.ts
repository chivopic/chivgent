import { describe, expect, it, vi } from "vitest";
import { EditorDocument } from "../src/tui/editor.js";
import { EditorController } from "../src/tui/editor-input.js";

describe("undo and redo", () => {
  it("restores text and cursor across inserts, deletes and codepoint-safe edits", () => {
    const document = new EditorDocument();
    document.insert("Hi 👩‍💻");
    document.backspace();
    expect(document.text).toBe("Hi ");
    document.undo();
    expect(document.text).toBe("Hi 👩‍💻");
    expect(document.cursor).toBe(document.text.length);
    document.undo();
    expect(document.text).toBe("");
    document.redo();
    expect(document.text).toBe("Hi 👩‍💻");
    document.redo();
    expect(document.text).toBe("Hi ");
  });

  it("clears redo state when a new edit diverges from older history", () => {
    const doc = new EditorDocument();
    doc.insert("a");
    doc.insert("b");
    doc.undo();
    doc.insert("c");
    doc.redo();
    expect(doc.text).toBe("ac");
  });
});

describe("default inline editor key contract", () => {
  function create(history: readonly string[] = []) {
    const results: (string | undefined)[] = [];
    const controller = new EditorController({
      columns: 80, rows: 24, write() {},
    }, text => results.push(text), { submitOnEnter: true, history });
    controller.begin();
    return { controller, results };
  }

  it("submits on Enter, inserts a multiline newline on Ctrl+O", () => {
    const { controller, results } = create();
    controller.receive(Buffer.from("first\u000osecond\r"));
    expect(results).toEqual(["first\nsecond"]);
  });

  it("supports interactive undo/redo without submitting the draft", () => {
    const { controller, results } = create();
    controller.receive(Buffer.from("abc\u001a\u0019\r"));
    expect(results).toEqual(["abc"]);
  });

  it("reverse-searches previous prompts and restores the matching draft", () => {
    const { controller, results } = create(["older", "Refactor API\nwith tests", "another"]);
    controller.receive(Buffer.from("\u0012API\r\r"));
    expect(results).toEqual(["Refactor API\nwith tests"]);
  });

  it("Ctrl+D exits only on an empty draft; Ctrl+C just cancels", () => {
    const first = create();
    first.controller.receive(Buffer.from("draft\u0004\r"));
    expect(first.results).toEqual(["draft"]);
    expect(first.controller.exitRequested.value).toBe(false);
    const second = create();
    second.controller.receive(Buffer.from("\u0004"));
    expect(second.results).toEqual([undefined]);
    expect(second.controller.exitRequested.value).toBe(true);
  });

  it("ignores untrusted ANSI output when loading history", () => {
    const { controller, results } = create(["unsafe\u001b[2J secret"]);
    controller.receive(Buffer.from("\u0012unsafe\r\r"));
    expect(results).toEqual(["unsafe[2J secret"]);
  });
});
