import { randomBytes } from "node:crypto";
import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeShellOutput } from "./sanitize.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  takeLastBytes,
  type TruncationResult,
} from "./truncate.js";
import { MAX_OUTPUT_FILE_BYTES } from "./output-store.js";

export const MAX_OUTPUT_BUFFERED_RAW_BYTES = 64 * 1024;
const OUTPUT_DECODE_CHUNK_BYTES = 8 * 1024;

export interface OutputAccumulatorOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly tempFilePrefix?: string;
  /** Overridable so tests do not write into the real temp directory. */
  readonly tempDirectory?: string;
  readonly maxSpillBytes?: number;
  readonly allowSpill?: boolean;
  /** Test seam for verifying persistence close failures. */
  readonly closeFile?: (descriptor: number) => void;
  readonly writeFileChunk?: (descriptor: number, chunk: Buffer, offset: number, length: number) => number;
}

export interface OutputSnapshot {
  readonly content: string;
  readonly truncation: TruncationResult;
  /** Set once the full output has been spilled to disk. */
  readonly fullOutputPath?: string;
  readonly fullOutputComplete: boolean;
  readonly fullOutputBytes: number;
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
  private readonly maxSpillBytes: number;
  private readonly allowSpill: boolean;
  private readonly tempFilePrefix: string;
  private readonly tempDirectory: string;
  private readonly closeFile: (descriptor: number) => void;
  private readonly writeFileChunk: (descriptor: number, chunk: Buffer, offset: number, length: number) => number;
  private readonly decoder = new TextDecoder("utf-8");

  private bufferedChunks: Buffer[] = [];
  private tail = "";
  private tailBytes = 0;
  private totalBytes = 0;
  private newlineCount = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileDescriptor: number | undefined;
  private spillBytes = 0;
  private retained = false;
  private spillComplete = true;
  private totalRawBytes = 0;
  private bufferedRawBytesValue = 0;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.maxSpillBytes = Math.min(options.maxSpillBytes ?? MAX_OUTPUT_FILE_BYTES, MAX_OUTPUT_FILE_BYTES);
    this.allowSpill = options.allowSpill ?? true;
    this.tempFilePrefix = options.tempFilePrefix ?? "chivgent-bash";
    this.tempDirectory = options.tempDirectory ?? tmpdir();
    this.closeFile = options.closeFile ?? closeSync;
    this.writeFileChunk = options.writeFileChunk ?? writeSync;
  }

  append(chunk: Buffer): void {
    // A detached descendant can still write after the command was finalised.
    // Throwing here would surface as an uncaught exception inside a stream
    // handler, so late output is dropped instead.
    if (this.finished) {
      return;
    }
    this.totalRawBytes += chunk.length;
    for (let offset = 0; offset < chunk.length; offset += OUTPUT_DECODE_CHUNK_BYTES) {
      this.appendText(this.decoder.decode(chunk.subarray(offset, Math.min(chunk.length, offset + OUTPUT_DECODE_CHUNK_BYTES)), { stream: true }));
    }

    if (this.tempFileDescriptor !== undefined || this.exceedsLimits() || this.bufferedRawBytesValue + chunk.length > MAX_OUTPUT_BUFFERED_RAW_BYTES) {
      this.spillToTempFile();
      this.writeSpill(chunk);
    } else if (chunk.length > 0) {
      this.bufferedChunks.push(chunk);
      this.bufferedRawBytesValue += chunk.length;
    }
  }

  /** Idempotent: the tool finishes on the happy path and again in its cleanup. */
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

  get bufferedRawBytes(): number { return this.bufferedRawBytesValue; }

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
      ...(this.tempFilePath === undefined ? {} : { fullOutputPath: this.tempFilePath }),
      fullOutputComplete: this.spillComplete && this.spillBytes === this.totalRawBytes,
      fullOutputBytes: this.spillBytes,
    };
  }

  /** Closes the private spill descriptor. Safe to call when there is none. */
  async close(): Promise<void> {
    if (this.tempFileDescriptor === undefined) return;
    try { this.closeFile(this.tempFileDescriptor); } catch { this.spillComplete = false; }
    this.tempFileDescriptor = undefined;
  }

  retain(): void { this.retained = true; }

  async discard(): Promise<void> {
    await this.close();
    if (this.retained || this.tempFilePath === undefined) return;
    try { unlinkSync(this.tempFilePath); } catch { /* output cleanup is best-effort */ }
    this.tempFilePath = undefined;
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
    this.tail = takeLastBytes(this.tail, this.maxRollingBytes);
    this.tailBytes = Buffer.byteLength(this.tail, "utf8");
  }

  private spillToTempFile(): void {
    if (!this.allowSpill) { this.spillComplete = false; this.bufferedChunks = []; this.bufferedRawBytesValue = 0; return; }
    if (this.tempFileDescriptor !== undefined || this.tempFilePath !== undefined || !this.spillComplete) {
      return;
    }
    const id = randomBytes(8).toString("hex");
    const filePath = path.join(
      this.tempDirectory,
      `${this.tempFilePrefix}-${id}.log`,
    );
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      this.tempFileDescriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      this.tempFilePath = filePath;
    } catch {
      this.spillComplete = false;
      this.bufferedChunks = [];
      this.bufferedRawBytesValue = 0;
      return;
    }
    for (const chunk of this.bufferedChunks) this.writeSpill(chunk);
    this.bufferedChunks = [];
    this.bufferedRawBytesValue = 0;
  }

  private writeSpill(chunk: Buffer): void {
    const descriptor = this.tempFileDescriptor;
    if (descriptor === undefined || chunk.length === 0) return;
    const amount = Math.min(chunk.length, Math.max(0, this.maxSpillBytes - this.spillBytes));
    try {
      // Synchronous bounded writes avoid an unbounded stream buffer when a
      // fast child produces output faster than the filesystem can persist it.
      let offset = 0;
      while (offset < amount) {
        const written = this.writeFileChunk(descriptor, chunk, offset, amount - offset);
        if (written <= 0) throw new Error("Unable to save shell output.");
        offset += written;
      }
      this.spillBytes += amount;
      if (amount < chunk.length) this.spillComplete = false;
    } catch {
      this.spillComplete = false;
      try { this.closeFile(descriptor); } catch { /* cleanup is best-effort after a write error */ }
      this.tempFileDescriptor = undefined;
      if (this.tempFilePath !== undefined) {
        try { unlinkSync(this.tempFilePath); } catch { /* output storage is best-effort */ }
      }
      this.tempFilePath = undefined;
      this.spillBytes = 0;
      this.bufferedRawBytesValue = 0;
    }
  }

}
