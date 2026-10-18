import { fitLine, terminalText } from "./text.js";
import { EditorPainter, type EditorFrame, type EditorOutput } from "./editor.js";

/**
 * Provider chooser for `/login`. It lists the same ids as `/provider` and is
 * painted inline, so it works in the readline TUI and in the inline composer.
 */
export function providerPickerFrame(
  providerIds: readonly string[],
  selected: number,
  active: string,
  width: number,
  height: number,
): EditorFrame {
  const cellWidth = Math.max(1, width - 1);
  const limit = Math.max(1, Math.min(providerIds.length, height - 3));
  const safeSelected = Math.max(0, Math.min(selected, providerIds.length - 1));
  const start = Math.max(0, Math.min(
    safeSelected - limit + 1,
    Math.max(0, providerIds.length - limit),
  ));
  const visible = providerIds.slice(start, start + limit);
  const lines = [fitLine("┌─ Select a Provider for /login", cellWidth)];
  if (visible.length === 0) {
    lines.push(fitLine("│ No Providers are available.", cellWidth));
  }
  visible.forEach((id, index) => {
    const itemIndex = start + index;
    const marker = itemIndex === safeSelected ? "❯" : " ";
    const current = id === active ? "●" : "○";
    lines.push(fitLine(`│ ${marker} ${current} ${terminalText(id)}`, cellWidth));
  });
  lines.push(fitLine("└─ ↑/↓ choose · Enter select · Esc cancel", cellWidth));
  return {
    lines,
    cursorRow: 1 + Math.max(0, Math.min(safeSelected - start, visible.length - 1)),
    cursorColumn: 2,
  };
}

/** Keyboard-only picker; Esc and Ctrl+C cancel without selecting. */
export class ProviderPickerController {
  private selected: number;
  private completed = false;
  private pending = "";
  private escapeTimer?: NodeJS.Timeout;
  private readonly painter: EditorPainter;

  constructor(
    private readonly output: EditorOutput,
    private readonly providerIds: readonly string[],
    private readonly active: string,
    private readonly done: (provider: string | undefined) => void,
  ) {
    this.painter = new EditorPainter(output);
    const current = providerIds.indexOf(active);
    this.selected = current < 0 ? 0 : current;
  }

  get selection(): string | undefined { return this.providerIds[this.selected]; }

  begin(): void {
    if (this.providerIds.length === 0) {
      this.finish(undefined);
      return;
    }
    this.draw();
  }

  resized(): void { if (!this.completed) this.draw(); }

  receive(chunk: Buffer): void {
    if (this.completed) return;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.pending += chunk.toString("utf8");

    while (this.pending.length > 0 && !this.completed) {
      if (this.pending.startsWith("\u001b[A") || this.pending.startsWith("\u001bOA")) {
        this.move(-1);
        this.pending = this.pending.slice(3);
      } else if (this.pending.startsWith("\u001b[B") || this.pending.startsWith("\u001bOB")) {
        this.move(1);
        this.pending = this.pending.slice(3);
      } else if (this.pending[0] === "\u001b") {
        if (this.pending === "\u001b" || this.pending === "\u001b[" || this.pending === "\u001bO") {
          this.escapeTimer = setTimeout(() => {
            if (this.pending === "\u001b") this.finish(undefined);
            else {
              this.pending = "";
              this.draw();
            }
          }, 40);
          break;
        }
        this.pending = "";
        this.finish(undefined);
      } else {
        const key = this.pending[0] ?? "";
        this.pending = this.pending.slice(1);
        if (key === "\r" || key === "\n") {
          this.finish(this.selection);
          return;
        }
        if (key === "\u0003" || key === "q" || key === "Q") {
          this.finish(undefined);
          return;
        }
        if (key === "k") this.move(-1);
        if (key === "j") this.move(1);
      }
    }
    if (!this.completed) this.draw();
  }

  cancel(): void { this.finish(undefined); }

  private move(delta: number): void {
    if (this.providerIds.length === 0) return;
    this.selected = (this.selected + delta + this.providerIds.length) % this.providerIds.length;
  }

  private draw(): void {
    this.painter.render(providerPickerFrame(
      this.providerIds,
      this.selected,
      this.active,
      Math.max(8, this.output.columns ?? 80),
      Math.max(6, this.output.rows ?? 24),
    ));
  }

  private finish(provider: string | undefined): void {
    if (this.completed) return;
    this.completed = true;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.painter.finish();
    this.done(provider);
  }
}
