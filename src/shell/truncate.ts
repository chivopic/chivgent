// Output truncation shared by the shell tool and anything else that has to fit
// unbounded output into a bounded result.

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
}

export interface TruncationResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
  /** True when the kept text starts mid-line because one line blew the budget. */
  readonly lastLinePartial: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Splits on newlines, keeping the terminator on the line it belongs to. */
function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n").map((line, index, all) =>
    index === all.length - 1 ? line : `${line}\n`,
  );
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** Keeps whole characters, never splitting a multi-byte sequence. */
function takeLastBytes(value: string, maxBytes: number): string {
  const characters = [...value];
  let bytes = 0;
  let index = characters.length;
  while (index > 0) {
    const size = byteLength(characters[index - 1] ?? "");
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    index -= 1;
  }
  return characters.slice(index).join("");
}

export function countLines(content: string): number {
  return splitLines(content).length;
}

/**
 * Keeps the end of the content.
 *
 * Shell output is truncated from the tail because that is where the answer is:
 * the failing assertion, the compiler's last error, the summary line. Reading a
 * file wants the opposite, which is why `read_file` keeps its own line-range
 * logic rather than sharing this one.
 */
export function truncateTail(
  content: string,
  options: TruncationOptions = {},
): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = byteLength(content);
  const lines = splitLines(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      maxLines,
      maxBytes,
    };
  }

  let bytes = 0;
  let index = lines.length;
  let stoppedBy: "lines" | "bytes" = "lines";
  while (index > 0) {
    if (lines.length - index >= maxLines) {
      stoppedBy = "lines";
      break;
    }
    const size = byteLength(lines[index - 1] ?? "");
    if (bytes + size > maxBytes) {
      stoppedBy = "bytes";
      break;
    }
    bytes += size;
    index -= 1;
  }

  // Not even one line fits: keep the tail of the last line so the result is
  // never empty just because a command printed one enormous line.
  if (index === lines.length) {
    const partial = takeLastBytes(lines.at(-1) ?? "", maxBytes);
    return {
      content: partial,
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: partial.length === 0 ? 0 : 1,
      outputBytes: byteLength(partial),
      lastLinePartial: true,
      maxLines,
      maxBytes,
    };
  }

  const kept = lines.slice(index);
  return {
    content: kept.join(""),
    truncated: true,
    truncatedBy: stoppedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: bytes,
    lastLinePartial: false,
    maxLines,
    maxBytes,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
