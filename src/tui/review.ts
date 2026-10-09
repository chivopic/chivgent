import { fitLine, terminalText } from "./text.js";
import { EditorPainter, type EditorFrame, type EditorOutput } from "./editor.js";

function decorated(line: string, width: number, color: boolean): string {
  const safe = fitLine(terminalText(line), width);
  if (!color) return safe;
  const source = line.startsWith("│ ") ? line.slice(2) : line;
  const code = source.startsWith("+") ? "32"
    : source.startsWith("-") ? "31"
    : source.startsWith("***") || source.startsWith("@@") ? "36"
    : undefined;
  return code === undefined ? safe : `\u001b[${code}m${safe}\u001b[0m`;
}

export interface ReviewFrame extends EditorFrame {
  readonly pageCount: number;
}

/** Read-only, viewport-limited patch review; no shell pager or file mutation. */
export function reviewFrame(
  patch: string,
  page: number,
  width: number,
  height: number,
  color = false,
  label = "applied patch (not live git diff)",
): ReviewFrame {
  const cellWidth = Math.max(8, width - 1);
  const pageLines = Math.max(1, Math.min(24, height - 5));
  const all = terminalText(patch).split("\n");
  const pageCount = Math.max(1, Math.ceil(all.length / pageLines));
  const selected = Math.max(1, Math.min(page, pageCount));
  const slice = all.slice((selected - 1) * pageLines, selected * pageLines);
  const head = fitLine(`┌─ Patch review · page ${selected}/${pageCount} · ${label}`, cellWidth);
  const foot = fitLine("└─ ↓/n next · ↑/p previous · q/Esc close", cellWidth);
  return {
    lines: [head, ...slice.map(line => decorated(`│ ${line}`, cellWidth, color)), foot],
    cursorRow: slice.length + 1,
    cursorColumn: 0,
    pageCount,
  };
}

export class PatchReviewController {
  private readonly painter: EditorPainter;
  private page = 1;
  private pageCount = 1;
  private completed = false;
  private pending = "";
  private escapeTimer?: NodeJS.Timeout;

  constructor(
    private readonly output: EditorOutput,
    private readonly patch: string,
    private readonly finishCallback: () => void,
    private readonly color = false,
    private readonly label = "applied patch (not live git diff)",
  ) {
    this.painter = new EditorPainter(output);
  }

  begin(): void { this.draw(); }

  resized(): void { if (!this.completed) this.draw(); }

  receive(chunk: Buffer): void {
    if (this.completed) return;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.pending += chunk.toString("utf8");

    while (this.pending.length > 0 && !this.completed) {
      if (this.pending.startsWith("\u001b[B") || this.pending.startsWith("\u001b[6~")) {
        this.page += 1;
        this.pending = this.pending.slice(this.pending[2] === "B" ? 3 : 4);
      } else if (this.pending.startsWith("\u001b[A") || this.pending.startsWith("\u001b[5~")) {
        this.page -= 1;
        this.pending = this.pending.slice(this.pending[2] === "A" ? 3 : 4);
      } else if (this.pending[0] === "\u001b") {
        if (["\u001b", "\u001b[", "\u001b[5", "\u001b[6"].includes(this.pending)) {
          this.escapeTimer = setTimeout(() => {
            if (this.pending === "\u001b") this.finish();
            else this.pending = "";
          }, 40);
          break;
        }
        this.pending = this.pending.slice(1);
        this.finish();
      } else {
        const key = this.pending[0] ?? "";
        this.pending = this.pending.slice(1);
        if (key === "q" || key === "Q" || key === "\u0003") this.finish();
        if (key === "n" || key === "j" || key === " " || key === "\r") this.page += 1;
        if (key === "p" || key === "k") this.page -= 1;
      }
    }
    if (!this.completed) this.draw();
  }

  cancel(): void { this.finish(); }

  private draw(): void {
    const frame = reviewFrame(
      this.patch, this.page,
      Math.max(8, this.output.columns ?? 80),
      Math.max(6, this.output.rows ?? 24),
      this.color,
      this.label,
    );
    this.pageCount = frame.pageCount;
    this.page = Math.max(1, Math.min(this.page, this.pageCount));
    this.painter.render(frame);
  }

  private finish(): void {
    if (this.completed) return;
    this.completed = true;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.painter.finish();
    this.finishCallback();
  }
}
