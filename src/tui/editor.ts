import { displayWidth, fitLine, fitLineTail, terminalText } from "./text.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 200;

function boundaries(text: string): number[] {
  return [0, ...[...segmenter.segment(text)].map(item => item.index + item.segment.length)];
}
function previous(text: string, cursor: number): number {
  return boundaries(text).filter(value => value < cursor).at(-1) ?? 0;
}
function next(text: string, cursor: number): number {
  return boundaries(text).find(value => value > cursor) ?? text.length;
}
function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", cursor - 1) + 1;
}
function lineEnd(text: string, cursor: number): number {
  const end = text.indexOf("\n", cursor);
  return end < 0 ? text.length : end;
}

/**
 * Editor state is terminal-independent. All positions are UTF-16 offsets at
 * grapheme boundaries; edits never split a joined emoji or combining mark.
 */
export class EditorDocument {
  text = "";
  cursor = 0;
  readonly maxBytes = MAX_BYTES;
  readonly maxLines = MAX_LINES;
  warning = "";
  private preferredCell?: number;

  insert(value: string): boolean {
    const normalized = terminalText(value).replace(/\r\n?/g, "\n");
    if (Buffer.byteLength(this.text, "utf8") + Buffer.byteLength(normalized, "utf8") > MAX_BYTES ||
        this.text.split("\n").length + normalized.split("\n").length - 1 > MAX_LINES) {
      this.warning = "Draft limit: 64 KiB / 200 lines";
      return false;
    }
    this.text = this.text.slice(0, this.cursor) + normalized + this.text.slice(this.cursor);
    this.cursor += normalized.length;
    this.preferredCell = undefined;
    this.warning = "";
    return true;
  }

  left(): void { this.cursor = previous(this.text, this.cursor); this.preferredCell = undefined; }
  right(): void { this.cursor = next(this.text, this.cursor); this.preferredCell = undefined; }
  home(): void { this.cursor = lineStart(this.text, this.cursor); this.preferredCell = undefined; }
  end(): void { this.cursor = lineEnd(this.text, this.cursor); this.preferredCell = undefined; }

  backspace(): void {
    if (this.cursor === 0) return;
    const at = previous(this.text, this.cursor);
    this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
    this.cursor = at;
    this.preferredCell = undefined;
  }
  delete(): void {
    if (this.cursor === this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(next(this.text, this.cursor));
    this.preferredCell = undefined;
  }
  moveVertical(direction: -1 | 1): void {
    const begin = lineStart(this.text, this.cursor);
    const column = this.preferredCell ?? displayWidth(this.text.slice(begin, this.cursor));
    this.preferredCell = column;
    if (direction < 0 && begin === 0) return;
    const end = lineEnd(this.text, this.cursor);
    if (direction > 0 && end === this.text.length) return;
    const targetStart = direction < 0 ? lineStart(this.text, begin - 1) : end + 1;
    const targetEnd = lineEnd(this.text, targetStart);
    const target = this.text.slice(targetStart, targetEnd);
    let result = targetStart;
    for (const grapheme of segmenter.segment(target)) {
      const candidate = targetStart + grapheme.index + grapheme.segment.length;
      if (displayWidth(this.text.slice(targetStart, candidate)) > column) break;
      result = candidate;
    }
    this.cursor = result;
  }

  get position(): { row: number; column: number } {
    return {
      row: this.text.slice(0, this.cursor).split("\n").length - 1,
      column: displayWidth(this.text.slice(lineStart(this.text, this.cursor), this.cursor)),
    };
  }
}

export interface EditorFrame {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/** Fixed-height viewport; keep caret in frame even on small terminals. */
export function editorFrame(document: EditorDocument, width: number, height: number): EditorFrame {
  const cellWidth = Math.max(8, width - 1);
  const rowLimit = Math.max(1, Math.min(8, height - 5));
  const rows = document.text.split("\n");
  const position = document.position;
  const first = Math.max(0, Math.min(position.row - rowLimit + 1, rows.length - rowLimit));
  const visible = rows.slice(first, first + rowLimit);
  const inputWidth = Math.max(1, cellWidth - 3);
  const body = visible.map((line, index) => {
    const original = terminalText(line);
    const caret = index + first === position.row ? position.column : 0;
    let display = original;
    let scrollCells = 0;
    if (displayWidth(display) > inputWidth) {
      if (caret > inputWidth - 2) {
        const target = Math.max(0, caret - inputWidth + 3);
        const pieces = [...segmenter.segment(display)].map(seg => seg.segment);
        let consumed = 0;
        let begin = 0;
        for (; begin < pieces.length; begin += 1) {
          if (consumed >= target) break;
          consumed += displayWidth(pieces[begin] ?? "");
        }
        scrollCells = consumed;
        display = "…" + pieces.slice(begin).join("");
      }
      display = fitLine(display, inputWidth);
    }
    return {
      row: fitLine(`│ ${display}`, cellWidth),
      caret: Math.min(cellWidth - 1, 2 + Math.max(0, caret - scrollCells) + (scrollCells > 0 ? 1 : 0)),
    };
  });
  const header = fitLine("┌─ Edit prompt · Enter newline · Ctrl+S send · Esc cancel", cellWidth);
  const footer = fitLine(
    document.warning || `└─ ${rows.length} lines · ${Buffer.byteLength(document.text, "utf8")} bytes · ↑↓←→ move`,
    cellWidth,
  );
  return {
    lines: [header, ...body.map(item => item.row), footer],
    cursorRow: 1 + (position.row - first),
    cursorColumn: body[position.row - first]?.caret ?? 2,
  };
}

export interface EditorOutput {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
}

/**
 * Inline redraw owns exactly its own rows, not the alternate screen.
 * The cursor is restored to the editable cell after every frame.
 */
export class EditorPainter {
  private previousRows = 0;
  private cursorRow = 0;
  private started = false;
  constructor(private readonly output: EditorOutput) {}

  render(frame: EditorFrame): void {
    const total = Math.max(this.previousRows, frame.lines.length);
    let escape = "";
    if (!this.started) {
      escape += "\r\n";
      this.started = true;
    } else if (this.cursorRow > 0) {
      escape += `\r\u001b[${this.cursorRow}A`;
    } else {
      escape += "\r";
    }
    for (let i = 0; i < total; i += 1) {
      escape += `\r\u001b[2K${frame.lines[i] ?? ""}`;
      if (i < total - 1) escape += "\r\n";
    }
    if (total - 1 > frame.cursorRow) escape += `\u001b[${total - 1 - frame.cursorRow}A`;
    escape += `\u001b[${frame.cursorColumn + 1}G`;
    this.output.write(escape);
    this.previousRows = total;
    this.cursorRow = frame.cursorRow;
  }

  finish(): void {
    if (!this.started) return;
    let escape = this.cursorRow > 0 ? `\r\u001b[${this.cursorRow}A` : "\r";
    for (let i = 0; i < this.previousRows; i += 1) {
      escape += "\r\u001b[2K";
      if (i < this.previousRows - 1) escape += "\u001b[1B";
    }
    if (this.previousRows > 1) escape += `\u001b[${this.previousRows - 1}A`;
    this.output.write(escape + "\r\n");
    this.previousRows = 0;
    this.started = false;
    this.cursorRow = 0;
  }
}
