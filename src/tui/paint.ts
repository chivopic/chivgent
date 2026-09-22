import { displayWidth } from "./text.js";
import type { OutputStream } from "../render.js";

const CURSOR_UP = "\u001B[A";
const CLEAR_LINE = "\u001B[2K";
const CARRIAGE_RETURN = "\r";

export interface PainterOptions {
  readonly stream: OutputStream;
}

/**
 * Draws the live region and keeps it up to date.
 *
 * Rewrites only the lines whose content changed. The cost model here is bytes
 * written to a terminal, and line granularity already turns the common case —
 * a timer ticking in the status line — from repainting the block into
 * rewriting one line. Cell-level diffing buys the rest, and in a region of
 * five or six lines it is not worth what it costs to build.
 */
export class Painter {
  /**
   * The lines currently on screen. The cursor is always on the blank line
   * just below them, which is what lets the caller keep its own prompt line
   * without the painter knowing anything about it.
   */
  private previous: readonly string[] = [];
  private invalidated = false;
  private previousRows = 0;

  constructor(private readonly options: PainterOptions) {}

  /**
   * Discards the diff baseline.
   *
   * After a resize the previous line array no longer describes what is on
   * screen — the terminal has reflowed it — so comparing against it would keep
   * lines that are no longer there. This is the one moment a full repaint is
   * the correct answer rather than a lazy one.
   */
  invalidate(columns?: number, rows?: number): void {
    this.invalidated = true;
    if (columns !== undefined && columns > 0) {
      this.previousRows = this.previous.reduce(
        (rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / columns)),
        0,
      );
    }
    // Reflow can push part of the region into scrollback. Cursor-up cannot
    // reach it; counting it as visible would scroll the replacement away
    // while erasing the old rows. Reserve the blank row below the region.
    if (rows !== undefined && rows > 0) {
      this.previousRows = Math.min(this.previousRows, Math.max(0, rows - 1));
    }
  }

  render(lines: readonly string[]): void {
    if (!this.invalidated && sameLines(this.previous, lines)) {
      return;
    }
    // Back to the top of the region, then forward a line at a time, so the
    // cursor ends where it began and the caller's prompt line is undisturbed.
    let out = CURSOR_UP.repeat(this.previousRows) + CARRIAGE_RETURN;

    const height = Math.max(this.previousRows, lines.length);
    for (let index = 0; index < height; index += 1) {
      const next = lines[index];
      if (next === undefined) {
        // The region shrank: erase the leftover rather than leaving it behind.
        out += `${CLEAR_LINE}\n`;
        continue;
      }
      out += !this.invalidated && this.previous[index] === next ? "\n" : `${CLEAR_LINE}${next}\n`;
    }

    // A shrunken region left the cursor below its new last line.
    if (height > lines.length) {
      out += CURSOR_UP.repeat(height - lines.length);
    }

    this.options.stream.write(out);
    this.previous = [...lines];
    this.previousRows = lines.length;
    this.invalidated = false;
  }

  /** Erases the region entirely, leaving the cursor where it began. */
  clear(): void {
    const height = this.previousRows;
    if (height === 0) {
      return;
    }
    this.options.stream.write(
      CURSOR_UP.repeat(height) +
        CARRIAGE_RETURN +
        `${CLEAR_LINE}\n`.repeat(height) +
        CURSOR_UP.repeat(height),
    );
    this.previous = [];
    this.previousRows = 0;
    this.invalidated = false;
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}
