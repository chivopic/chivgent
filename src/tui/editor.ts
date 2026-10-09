import { displayWidth, fitLine, terminalText } from "./text.js";

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
  selectionAnchor?: number;

  selectionRange(): { start: number; end: number } | undefined {
    if (this.selectionAnchor === undefined || this.selectionAnchor === this.cursor) return undefined;
    return { start: Math.min(this.selectionAnchor, this.cursor), end: Math.max(this.selectionAnchor, this.cursor) };
  }

  /** Hit test is grapheme-safe and uses display cell positions, not JS string indices. */
  placeAt(row: number, column: number, extend = false): void {
    const rows = this.text.split("\n");
    const safeRow = Math.max(0, Math.min(Math.floor(row), rows.length - 1));
    const target = rows[safeRow] ?? "";
    const start = rows.slice(0, safeRow).reduce((total, value) => total + value.length + 1, 0);
    let offset = 0;
    for (const grapheme of segmenter.segment(target)) {
      const end = grapheme.index + grapheme.segment.length;
      if (displayWidth(target.slice(0, end)) > column) break;
      offset = end;
    }
    if (extend) {
      this.selectionAnchor ??= this.cursor;
    } else this.selectionAnchor = undefined;
    this.cursor = start + offset;
    this.preferredCell = undefined;
    this.lastTyping = false;
  }

  private deleteSelection(): boolean {
    const range = this.selectionRange();
    if (range === undefined) return false;
    this.checkpoint();
    this.text = this.text.slice(0, range.start) + this.text.slice(range.end);
    this.cursor = range.start;
    this.selectionAnchor = undefined;
    return true;
  }
  private undoStack: { text: string; cursor: number }[] = [];
  private redoStack: { text: string; cursor: number }[] = [];
  private static readonly MAX_HISTORY = 100;
  private lastTyping = false;

  private checkpoint(typing = false): void {
    if (typing && this.lastTyping) return;
    this.lastTyping = typing;
    this.undoStack.push({ text: this.text, cursor: this.cursor });
    if (this.undoStack.length > EditorDocument.MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push({ text: this.text, cursor: this.cursor });
    this.text = previous.text;
    this.cursor = previous.cursor;
    this.selectionAnchor = undefined;
    this.lastTyping = false;
    this.preferredCell = undefined;
    this.warning = "";
  }

  redo(): void {
    const nextState = this.redoStack.pop();
    if (nextState === undefined) return;
    this.undoStack.push({ text: this.text, cursor: this.cursor });
    this.text = nextState.text;
    this.cursor = nextState.cursor;
    this.selectionAnchor = undefined;
    this.lastTyping = false;
    this.preferredCell = undefined;
    this.warning = "";
  }

  /** Restore a prior submitted prompt as a fresh editable draft. */
  loadDraft(value: string): boolean {
    const normalized = terminalText(value).replace(/\r\n?/g, "\n");
    if (Buffer.byteLength(normalized, "utf8") > MAX_BYTES || normalized.split("\n").length > MAX_LINES) return false;
    this.checkpoint();
    this.text = normalized;
    this.cursor = normalized.length;
    this.selectionAnchor = undefined;
    this.preferredCell = undefined;
    return true;
  }

  insert(value: string, typing = false): boolean {
    const normalized = terminalText(value).replace(/\r\n?/g, "\n");
    const rangeBefore = this.selectionRange();
    const nextText = rangeBefore === undefined
      ? this.text.slice(0, this.cursor) + normalized + this.text.slice(this.cursor)
      : this.text.slice(0, rangeBefore.start) + normalized + this.text.slice(rangeBefore.end);
    if (Buffer.byteLength(nextText, "utf8") > MAX_BYTES ||
        nextText.split("\n").length > MAX_LINES) {
      this.warning = "Draft limit: 64 KiB / 200 lines";
      return false;
    }
    if (normalized.length === 0) return true;
    this.checkpoint(typing);
    const range = this.selectionRange();
    if (range !== undefined) {
      this.text = this.text.slice(0, range.start) + normalized + this.text.slice(range.end);
      this.cursor = range.start + normalized.length;
      this.selectionAnchor = undefined;
    } else {
      this.text = this.text.slice(0, this.cursor) + normalized + this.text.slice(this.cursor);
    }
    if (range === undefined) this.cursor += normalized.length;
    this.preferredCell = undefined;
    this.warning = "";
    return true;
  }

  left(): void { this.cursor = previous(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; this.selectionAnchor = undefined; }
  right(): void { this.cursor = next(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; this.selectionAnchor = undefined; }
  home(): void { this.cursor = lineStart(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; this.selectionAnchor = undefined; }
  end(): void { this.cursor = lineEnd(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; this.selectionAnchor = undefined; }

  backspace(): void {
    if (this.deleteSelection()) return;
    if (this.cursor === 0) return;
    const at = previous(this.text, this.cursor);
    this.checkpoint();
    this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
    this.cursor = at;
    this.preferredCell = undefined;
  }
  delete(): void {
    if (this.deleteSelection()) return;
    if (this.cursor === this.text.length) return;
    this.checkpoint();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(next(this.text, this.cursor));
    this.preferredCell = undefined;
  }
  moveVertical(direction: -1 | 1): void {
    this.lastTyping = false;
    this.selectionAnchor = undefined;
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
export function editorFrame(document: EditorDocument, width: number, height: number, submitOnEnter = false, suggestions: readonly string[] = [], selectedSuggestion = 0): EditorFrame {
  const cellWidth = Math.max(8, width - 1);
  const displayedSuggestions = suggestions.slice(0, Math.max(0, height - 7));
  const rowLimit = Math.max(1, Math.min(8, height - 5 - displayedSuggestions.length));
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
      row: (() => {
        const baseline = fitLine(`│ ${display}`, cellWidth);
        const selection = document.selectionRange();
        if (selection === undefined || display !== original) return baseline;
        const rowIndex = first + index;
        const start = rows.slice(0, rowIndex).reduce((sum, row) => sum + row.length + 1, 0);
        const lo = Math.max(0, selection.start - start);
        const hi = Math.min(original.length, selection.end - start);
        if (hi <= lo) return baseline;
        // ANSI reverse video applies only after width clipping, so it does
        // not affect terminal columns or permit untrusted escape injection.
        return `│ ${original.slice(0, lo)}\u001b[7m${original.slice(lo, hi)}\u001b[0m${original.slice(hi)}`;
      })(),
      caret: Math.min(cellWidth - 1, 2 + Math.max(0, caret - scrollCells) + (scrollCells > 0 ? 1 : 0)),
    };
  });
  const header = fitLine(submitOnEnter
    ? "┌─ Enter send · Ctrl+O newline · Ctrl+R history"
    : "┌─ Ctrl+S send · Esc cancel · Enter newline", cellWidth);
  const popup = displayedSuggestions.map((item, index) => fitLine(`  ${index === selectedSuggestion ? "›" : " "} /${item}`, cellWidth));
  const footer = fitLine(
    document.warning || (document.selectionRange() === undefined
      ? `└─ ${rows.length} lines · ${Buffer.byteLength(document.text, "utf8")} bytes · ↑↓←→ move`
      : `└─ Selected ${document.selectionRange()!.end - document.selectionRange()!.start} code units · type to replace`),
    cellWidth,
  );
  return {
    lines: [header, ...body.map(item => item.row), ...popup, footer],
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
