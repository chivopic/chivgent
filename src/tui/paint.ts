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

  constructor(private readonly options: PainterOptions) {}

  /**
   * Discards the diff baseline.
   *
   * After a resize the previous line array no longer describes what is on
   * screen — the terminal has reflowed it — so comparing against it would keep
   * lines that are no longer there. This is the one moment a full repaint is
   * the correct answer rather than a lazy one.
   */
  invalidate(): void {
    this.previous = [];
  }

  render(lines: readonly string[]): void {
    if (sameLines(this.previous, lines)) {
      return;
    }
    // Back to the top of the region, then forward a line at a time, so the
    // cursor ends where it began and the caller's prompt line is undisturbed.
    let out = CURSOR_UP.repeat(this.previous.length) + CARRIAGE_RETURN;

    const height = Math.max(this.previous.length, lines.length);
    for (let index = 0; index < height; index += 1) {
      const next = lines[index];
      if (next === undefined) {
        // The region shrank: erase the leftover rather than leaving it behind.
        out += `${CLEAR_LINE}\n`;
        continue;
      }
      out += this.previous[index] === next ? "\n" : `${CLEAR_LINE}${next}\n`;
    }

    // A shrunken region left the cursor below its new last line.
    if (height > lines.length) {
      out += CURSOR_UP.repeat(height - lines.length);
    }

    this.options.stream.write(out);
    this.previous = [...lines];
  }

  /** Erases the region entirely, leaving the cursor where it began. */
  clear(): void {
    const height = this.previous.length;
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
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}
