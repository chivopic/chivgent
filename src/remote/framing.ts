/**
 * JSON Lines framing.
 *
 * One JSON object per line, the same shape the session log and `--json` mode
 * already use. A length-prefixed binary frame would be needed to carry
 * attachments; every message here is required to be JSON-serialisable, so the
 * simpler framing is enough and stays inspectable with `nc`.
 */

export const MAX_LINE_BYTES = 1024 * 1024;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

export function encodeMessage(value: unknown): string {
  const line = JSON.stringify(value);
  if (line === undefined) {
    throw new FramingError("Message is not JSON-serialisable.");
  }
  return `${line}\n`;
}

/**
 * Splits a byte stream into lines without unbounded buffering.
 *
 * A peer that never sends a newline must not be able to exhaust memory, so the
 * buffer is capped and overflow is a protocol error rather than a slow death.
 */
export class LineDecoder {
  private fragments: string[] = [];
  private bufferedBytes = 0;
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let start = 0;

    // Scan only newly decoded text. Joining an unfinished line on every push
    // repeatedly copies and scans its prefix when the transport fragments it.
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end === -1) {
        this.appendFragment(text.slice(start));
        break;
      }
      this.appendFragment(text.slice(start, end));
      const trimmed = this.fragments.join("").trim();
      this.fragments = [];
      this.bufferedBytes = 0;
      if (trimmed.length > 0) {
        lines.push(trimmed);
      }
      start = end + 1;
    }
    return lines;
  }

  private appendFragment(fragment: string): void {
    const bytes = Buffer.byteLength(fragment, "utf8");
    if (this.bufferedBytes + bytes > this.maxLineBytes) {
      throw new FramingError(
        `A single line exceeded the ${this.maxLineBytes}-byte limit.`,
      );
    }
    if (fragment.length > 0) {
      this.fragments.push(fragment);
      this.bufferedBytes += bytes;
    }
  }
}

/** Parses one line, or returns why it could not be parsed. */
export function parseLine(
  line: string,
): { readonly value: unknown } | { readonly error: string } {
  try {
    return { value: JSON.parse(line) };
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : "Invalid JSON.",
    };
  }
}
