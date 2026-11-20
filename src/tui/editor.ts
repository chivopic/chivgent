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
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push({ text: this.text, cursor: this.cursor });
    this.text = prev.text;
    this.cursor = prev.cursor;
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
    this.preferredCell = undefined;
    this.warning = "";
    return true;
  }

  insert(value: string, typing = false): boolean {
    const normalized = terminalText(value).replace(/\r\n?/g, "\n");
    const nextText = this.text.slice(0, this.cursor) + normalized + this.text.slice(this.cursor);
    if (Buffer.byteLength(nextText, "utf8") > MAX_BYTES ||
        nextText.split("\n").length > MAX_LINES) {
      this.warning = "Draft limit: 64 KiB / 200 lines";
      return false;
    }
    if (normalized.length === 0) return true;
    this.checkpoint(typing);
    this.text = nextText;
    this.cursor += normalized.length;
    this.preferredCell = undefined;
    this.warning = "";
    return true;
  }

  left(): void { this.cursor = previous(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; }
  right(): void { this.cursor = next(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; }
  home(): void { this.cursor = lineStart(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; }
  end(): void { this.cursor = lineEnd(this.text, this.cursor); this.preferredCell = undefined; this.lastTyping = false; }

  backspace(): void {
    if (this.cursor === 0) return;
    const at = previous(this.text, this.cursor);
    this.checkpoint();
    this.text = this.text.slice(0, at) + this.text.slice(this.cursor);
    this.cursor = at;
    this.preferredCell = undefined;
  }

  delete(): void {
    if (this.cursor === this.text.length) return;
    this.checkpoint();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(next(this.text, this.cursor));
    this.preferredCell = undefined;
  }

  moveVertical(direction: -1 | 1): void {
    this.lastTyping = false;
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

export interface EditorFrameOptions {
  readonly suggestions?: readonly { readonly value: string; readonly label: string }[];
  readonly selectedSuggestion?: number;
  readonly footerStatus?: string;
  readonly color?: boolean;
  readonly footerIdentity?: string;
}

const PLACEHOLDER = "Ask chivgent to do anything";
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const YELLOW = "\u001b[33m";
const BOLD_CYAN = "\u001b[1;36m";

function boxRule(left: string, right: string, width: number): string {
  return `${left}${"─".repeat(Math.max(0, width - displayWidth(left) - displayWidth(right)))}${right}`;
}

function closeBox(left: string, inner: string, innerWidth: number, right: string): string {
  return `${left}${inner}${" ".repeat(Math.max(0, innerWidth - displayWidth(inner)))}${right}`;
}

/**
 * Provider and model sit on the left while the mode hint aligns to the right.
 * When the line is tight, the mode hint stays whole and the model name shrinks.
 */
function composeFooter(identity: string | undefined, status: string, columns: number, color = false): string {
  const width = Math.max(0, Math.floor(columns));
  if (width === 0) return "";
  const cleanStatus = terminalText(status).replace(/\n/g, " ");
  const cleanIdentity = identity === undefined ? "" : terminalText(identity).replace(/\n/g, " ");
  const paintStatus = (value: string): string => (color && value.length > 0 ? `${DIM}${value}${RESET}` : value);
  if (cleanIdentity.length === 0) return paintStatus(fitLine(cleanStatus, width));
  const statusWidth = displayWidth(cleanStatus);
  if (statusWidth >= width) return paintStatus(fitLine(cleanStatus, width));
  const identityWidth = displayWidth(cleanIdentity);
  const minGap = 2;
  if (identityWidth + minGap + statusWidth <= width) {
    const gap = width - identityWidth - statusWidth;
    return `${cleanIdentity}${" ".repeat(gap)}${paintStatus(cleanStatus)}`;
  }
  const room = width - statusWidth - minGap;
  if (room < 2) return paintStatus(cleanStatus);
  return `${fitLine(cleanIdentity, room)}${" ".repeat(minGap)}${paintStatus(cleanStatus)}`;
}

/** Fixed-height rounded composer viewport; keeps caret in frame on small terminals. */
export function editorFrame(
  document: EditorDocument,
  width: number,
  height: number,
  options: EditorFrameOptions = {},
): EditorFrame {
  const suggestions = options.suggestions ?? [];
  const selectedSuggestion = options.selectedSuggestion ?? 0;
  const color = options.color === true;
  const lineWidth = Math.max(1, width - 1);
  const maxSuggestions = 5;
  const suggestionLimit = Math.max(0, Math.min(maxSuggestions, height - 7));
  const visibleSuggestionCount = Math.min(suggestions.length, suggestionLimit);
  const suggestionStart = Math.max(0, Math.min(
    selectedSuggestion - visibleSuggestionCount + 1,
    suggestions.length - visibleSuggestionCount,
  ));
  const displayedSuggestions = suggestions.slice(suggestionStart, suggestionStart + visibleSuggestionCount);
  const rowLimit = Math.max(1, Math.min(8, height - 6 - displayedSuggestions.length));
  const rows = document.text.split("\n");
  const position = document.position;
  const first = Math.max(0, Math.min(position.row - rowLimit + 1, rows.length - rowLimit));
  const visible = rows.slice(first, first + rowLimit);
  const left = "│ ";
  const right = " │";
  const styledLeft = color ? `${DIM}${left}${RESET}` : left;
  const styledRight = color ? `${DIM}${right}${RESET}` : right;
  const innerWidth = Math.max(1, lineWidth - displayWidth(left) - displayWidth(right));
  const inputWidth = Math.max(1, innerWidth - 2);
  const showingPlaceholder = document.text.length === 0;

  const body = visible.map((line, index) => {
    const original = terminalText(line);
    const caret = index + first === position.row ? position.column : 0;
    const placeholder = showingPlaceholder && index + first === 0;
    let display = original;
    let scrollCells = 0;
    if (!placeholder && displayWidth(display) > inputWidth) {
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
    const isCurrentRow = index + first === position.row;
    const marker = isCurrentRow ? "› " : "  ";
    const styledMarker = color && isCurrentRow ? `${BOLD_CYAN}›${RESET} ` : marker;
    const gutterCells = displayWidth(left) + displayWidth(marker);
    const row = placeholder
      ? closeBox(styledLeft, `${styledMarker}${color ? `${DIM}${fitLine(PLACEHOLDER, inputWidth)}${RESET}` : fitLine(PLACEHOLDER, inputWidth)}`, innerWidth, styledRight)
      : closeBox(styledLeft, `${styledMarker}${display}`, innerWidth, styledRight);
    return {
      row,
      caret: Math.min(lineWidth - 1, gutterCells + Math.max(0, caret - scrollCells) + (scrollCells > 0 ? 1 : 0)),
    };
  });

  const plainHeader = boxRule("╭", "╮", lineWidth);
  const header = color ? `${DIM}${plainHeader}${RESET}` : plainHeader;
  const plainBottom = boxRule("╰", "╯", lineWidth);
  const bottom = color ? `${DIM}${plainBottom}${RESET}` : plainBottom;

  const popup = displayedSuggestions.map((item, index) => {
    const isSelected = suggestionStart + index === selectedSuggestion;
    const text = fitLine(`  ${isSelected ? "›" : " "} ${item.label || `/${item.value}`}`, lineWidth);
    if (!color) return text;
    if (isSelected && text.startsWith("  ›")) {
      return `  ${BOLD_CYAN}›${RESET}${text.slice(3)}`;
    }
    return `${DIM}${text}${RESET}`;
  });

  const idleStatus = options.footerStatus ?? "/help for shortcuts";
  const footer = (() => {
    if (document.warning) {
      const fitted = fitLine(document.warning, lineWidth);
      return color && fitted.length > 0 ? `${YELLOW}${fitted}${RESET}` : fitted;
    }
    if (suggestions.length > 0) {
      const fitted = fitLine("↑↓ choose · Tab/Enter complete · Esc close", lineWidth);
      return color && fitted.length > 0 ? `${DIM}${fitted}${RESET}` : fitted;
    }
    return composeFooter(options.footerIdentity, idleStatus, lineWidth, color);
  })();

  const cursorOffset = position.row - first;
  return {
    lines: [header, ...body.map(item => item.row), bottom, ...popup, footer],
    cursorRow: 1 + cursorOffset,
    cursorColumn: body[cursorOffset]?.caret ?? 4,
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
    const total = Math.min(
      this.output.rows ?? Number.POSITIVE_INFINITY,
      Math.max(this.previousRows, frame.lines.length),
    );
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
