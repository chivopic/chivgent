import { describe, expect, it } from "vitest";
import { ProviderPickerController, providerPickerFrame } from "../src/tui/provider-picker.js";
import { displayWidth } from "../src/tui/text.js";

function make(ids: readonly string[] = ["openai", "deepseek", "openrouter"], active = "openai") {
  const written: string[] = [];
  const selected: (string | undefined)[] = [];
  const picker = new ProviderPickerController(
    { columns: 40, rows: 12, write: (part) => { written.push(part); } },
    ids,
    active,
    (provider) => { selected.push(provider); },
  );
  picker.begin();
  return { picker, written, selected };
}

describe("Provider picker", () => {
  it("marks the active Provider, keeps the selection visible, and fits the width", () => {
    const frame = providerPickerFrame(["openai", "deepseek", "openrouter"], 2, "openai", 48, 10);
    const body = frame.lines.join("\n");
    expect(body).toContain("Select a Provider for /login");
    expect(body).toContain("  ● openai");
    expect(body).toContain("❯ ○ openrouter");
    expect(frame.lines.every((line) => displayWidth(line) <= 47)).toBe(true);
    expect(frame.cursorRow).toBe(3);
  });

  it("starts on the active Provider and wraps with arrows", () => {
    const { picker } = make();
    expect(picker.selection).toBe("openai");
    picker.receive(Buffer.from("\u001b[A"));
    expect(picker.selection).toBe("openrouter");
    picker.receive(Buffer.from("\u001b[B"));
    expect(picker.selection).toBe("openai");
    picker.cancel();
  });

  it("selects with Enter and finishes once", () => {
    const { picker, selected, written } = make();
    picker.receive(Buffer.from("\u001b[B\r"));
    expect(selected).toEqual(["deepseek"]);
    picker.receive(Buffer.from("\r"));
    picker.cancel();
    expect(selected).toEqual(["deepseek"]);
    expect(written.join("")).toContain("Select a Provider for /login");
  });

  it("accepts an arrow split across chunks", () => {
    const { picker } = make();
    picker.receive(Buffer.from("\u001b["));
    picker.receive(Buffer.from("B"));
    expect(picker.selection).toBe("deepseek");
    picker.cancel();
  });

  it("cancels on Escape, Ctrl+C, and with no Providers", async () => {
    const escaped = make();
    escaped.picker.receive(Buffer.from("\u001b"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(escaped.selected).toEqual([undefined]);

    const interrupted = make();
    interrupted.picker.receive(Buffer.from("\u0003"));
    expect(interrupted.selected).toEqual([undefined]);

    const empty = make([]);
    expect(empty.selected).toEqual([undefined]);
    expect(empty.written.join("")).not.toContain("❯");
  });
});
