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
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];

    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        break;
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        lines.push(trimmed);
      }
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      throw new FramingError(
        `A single line exceeded the ${this.maxLineBytes}-byte limit.`,
      );
    }
    return lines;
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
