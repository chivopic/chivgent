import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeShellOutput } from "./sanitize.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type TruncationResult,
} from "./truncate.js";

export interface OutputAccumulatorOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly tempFilePrefix?: string;
  /** Overridable so tests do not write into the real temp directory. */
  readonly tempDirectory?: string;
}

export interface OutputSnapshot {
  readonly content: string;
  readonly truncation: TruncationResult;
  /** Set once the full output has been spilled to disk. */
  readonly fullOutputPath?: string;
}

/**
 * Collects streaming command output in bounded memory.
 *
 * Two things make this more than a string concatenation. Chunks are decoded
 * with a streaming decoder, because a multi-byte character split across a chunk
 * boundary decodes to garbage otherwise. And once the output passes the limits
 * the accumulator stops keeping it: it spills the raw bytes to a temp file and
 * holds only a rolling tail, so a command that prints a gigabyte does not cost
 * a gigabyte of memory.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private readonly tempDirectory: string;
  private readonly decoder = new TextDecoder("utf-8");

  private bufferedChunks: Buffer[] = [];
  private tail = "";
  private tailBytes = 0;
  private totalBytes = 0;
  private newlineCount = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "chivgent-bash";
    this.tempDirectory = options.tempDirectory ?? tmpdir();
  }

  append(chunk: Buffer): void {
    if (this.finished) {
      throw new Error("Cannot append to a finished output accumulator.");
    }
    this.appendText(this.decoder.decode(chunk, { stream: true }));

    if (this.tempFileStream !== undefined || this.exceedsLimits()) {
      this.spillToTempFile();
      this.tempFileStream?.write(chunk);
    } else if (chunk.length > 0) {
      this.bufferedChunks.push(chunk);
    }
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.appendText(this.decoder.decode());
    if (this.exceedsLimits()) {
      this.spillToTempFile();
    }
  }

  get totalLines(): number {
    return this.newlineCount + (this.hasOpenLine ? 1 : 0);
  }

  snapshot(): OutputSnapshot {
    const tailTruncation = truncateTail(this.tail, {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    // The tail alone cannot tell how much was dropped, so the totals come from
    // the counters that saw every chunk.
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated: this.exceedsLimits() || tailTruncation.truncated,
      truncatedBy: this.exceedsLimits()
        ? (tailTruncation.truncatedBy ??
          (this.totalBytes > this.maxBytes ? "bytes" : "lines"))
        : tailTruncation.truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
    };
    return {
      content: truncation.content,
      truncation,
      ...(this.tempFilePath === undefined
        ? {}
        : { fullOutputPath: this.tempFilePath }),
    };
  }

  /** Flushes and closes the spill file. Safe to call when there is none. */
  async close(): Promise<void> {
    const stream = this.tempFileStream;
    if (stream === undefined) {
      return;
    }
    this.tempFileStream = undefined;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private exceedsLimits(): boolean {
    return this.totalLines > this.maxLines || this.totalBytes > this.maxBytes;
  }

  private appendText(text: string): void {
    if (text.length === 0) {
      return;
    }
    const clean = sanitizeShellOutput(text);
    if (clean.length === 0) {
      return;
    }

    this.totalBytes += Buffer.byteLength(clean, "utf8");
    for (const character of clean) {
      if (character === "\n") {
        this.newlineCount += 1;
        this.hasOpenLine = false;
      } else {
        this.hasOpenLine = true;
      }
    }

    this.tail += clean;
    this.tailBytes += Buffer.byteLength(clean, "utf8");
    this.trimTail();
  }

  private trimTail(): void {
    if (this.tailBytes <= this.maxRollingBytes) {
      return;
    }
    // Dropping from the front can cut mid-line; truncateTail rebuilds whole
    // lines from what is left, and the totals stay correct either way.
    const characters = [...this.tail];
    let bytes = 0;
    let index = characters.length;
    while (index > 0) {
      const size = Buffer.byteLength(characters[index - 1] ?? "", "utf8");
      if (bytes + size > this.maxRollingBytes) {
        break;
      }
      bytes += size;
      index -= 1;
    }
    this.tail = characters.slice(index).join("");
    this.tailBytes = bytes;
  }

  private spillToTempFile(): void {
    if (this.tempFileStream !== undefined) {
      return;
    }
    const id = randomBytes(8).toString("hex");
    this.tempFilePath = path.join(
      this.tempDirectory,
      `${this.tempFilePrefix}-${id}.log`,
    );
    this.tempFileStream = createWriteStream(this.tempFilePath);
    // A spill file is a convenience: losing it must not fail the command.
    this.tempFileStream.on("error", () => undefined);
    for (const chunk of this.bufferedChunks) {
      this.tempFileStream.write(chunk);
    }
    this.bufferedChunks = [];
  }
}
