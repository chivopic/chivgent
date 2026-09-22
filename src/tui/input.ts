import { PassThrough } from "node:stream";

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
};

/**
 * Readline keeps its normal editing and history. During a run, only Ctrl+C
 * reaches it: typing must neither echo into the live region nor queue prompts.
 * The source stays in raw mode so cancellation still arrives immediately.
 */
export class TuiInput extends PassThrough {
  readonly isTTY: boolean;
  private busy = false;
  private submitted = false;
  private afterCR = false;

  constructor(private readonly source: TerminalInput) {
    super();
    this.isTTY = source.isTTY === true;
    source.on("data", this.receive);
    source.on("end", this.ended);
    source.on("error", this.failed);
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode?.(enabled);
    return this;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Called only when the REPL is ready to read its next line. */
  acceptLine(): void {
    this.submitted = false;
  }

  dispose(): void {
    this.source.off("data", this.receive);
    this.source.off("end", this.ended);
    this.source.off("error", this.failed);
    this.setRawMode(false);
    this.source.pause();
    this.destroy();
  }

  private readonly receive = (chunk: Buffer | string): void => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (bytes.length === 0) return;
    if (this.afterCR && bytes[0] === 10) bytes = bytes.subarray(1);
    this.afterCR = false;
    if (bytes.length === 0) return;
    if (this.busy || this.submitted) {
      if (bytes.includes(3)) this.write("\u0003");
      return;
    }

    // Stop at the first submission *before* readline receives the chunk.
    // Its async iterator can otherwise queue later lines before runRepl has
    // entered the busy state. Keep bytes intact for split UTF-8 characters.
    const end = bytes.findIndex((byte) => byte === 10 || byte === 13);
    if (end === -1) {
      this.write(bytes);
    } else {
      this.submitted = true;
      this.afterCR = bytes[end] === 13 && end === bytes.length - 1;
      this.write(bytes.subarray(0, end + 1));
    }
  };

  private readonly ended = (): void => { this.end(); };
  private readonly failed = (error: Error): void => { this.destroy(error); };
}
