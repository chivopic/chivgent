import { PassThrough } from "node:stream";

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
};

/**
 * Gates terminal input across TUI states without taking readline's prompt line
 * out of the terminal scrollback:
 * - `rawHandler` forwards raw bytes exclusively to modal/composer controllers.
 * - `busy` drops ordinary typing while keeping Ctrl+C cancellation responsive.
 * - `approvalMode` turns y/n/Escape into an immediate confirmation answer.
 * - `escapeHandler` disambiguates standalone Escape for structured questions.
 */
export class TuiInput extends PassThrough {
  readonly isTTY: boolean;
  private busy = false;
  private approvalMode = false;
  private rawHandler?: (chunk: Buffer) => void;
  private escapeHandler?: () => void;
  private submitted = false;
  private afterCR = false;
  private escapePrefix = Buffer.alloc(0);
  private escapeTimer?: NodeJS.Timeout;

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

  /** While approving, y/n/Escape answer immediately without Enter. */
  setApprovalMode(enabled: boolean): void {
    this.approvalMode = enabled;
  }

  /** Exclusive input for cursor-addressed controllers (composer, picker, review). */
  setRawHandler(handler: ((chunk: Buffer) => void) | undefined): void {
    this.clearEscapeTimer();
    this.rawHandler = handler;
  }

  /** Standalone Escape hook used while readline reads a structured question. */
  setEscapeHandler(handler: (() => void) | undefined): void {
    if (handler === undefined) this.clearEscapeTimer();
    this.escapeHandler = handler;
  }

  /** Called when readline is ready to accept the next line. */
  acceptLine(): void {
    this.submitted = false;
  }

  markSubmitted(): void {
    this.submitted = true;
  }

  dispose(): void {
    this.clearEscapeTimer();
    this.source.off("data", this.receive);
    this.source.off("end", this.ended);
    this.source.off("error", this.failed);
    this.setRawMode(false);
    this.source.pause();
    this.destroy();
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    this.escapePrefix = Buffer.alloc(0);
  }

  private readonly receive = (chunk: Buffer | string): void => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.escapePrefix.length > 0) {
      bytes = Buffer.concat([this.escapePrefix, bytes]);
      this.clearEscapeTimer();
    }
    if (bytes.length === 0) return;

    if (this.rawHandler !== undefined) {
      this.rawHandler(bytes);
      return;
    }

    if (this.afterCR && bytes[0] === 10) bytes = bytes.subarray(1);
    this.afterCR = false;
    if (bytes.length === 0) return;

    if (this.approvalMode && !this.submitted) {
      // Single-key approval; ignore extra pasted bytes and always allow Ctrl+C.
      if (bytes.includes(3)) {
        this.write("\u0003");
        return;
      }
      const first = bytes[0];
      if (first === 121 || first === 89 || first === 110 || first === 78 || first === 27) {
        this.submitted = true;
        this.write(first === 121 || first === 89 ? "y\r" : "n\r");
        return;
      }
    }

    if (this.busy || this.submitted) {
      if (bytes.includes(3)) this.write("\u0003");
      return;
    }

    let offset = 0;
    while (offset < bytes.length && !this.submitted) {
      const byte = bytes[offset];
      if (this.escapeHandler !== undefined && byte === 27) {
        if (offset + 1 === bytes.length) {
          this.escapePrefix = Buffer.from(bytes.subarray(offset));
          this.escapeTimer = setTimeout(() => {
            const pending = this.escapePrefix;
            this.clearEscapeTimer();
            if (pending.length === 1 && this.escapeHandler !== undefined) {
              this.escapeHandler();
            } else if (pending.length > 0) {
              this.write(pending);
            }
          }, 30);
          return;
        }
        const next = bytes[offset + 1];
        if (next !== 91 && next !== 79) {
          this.escapeHandler();
          offset += 1;
          continue;
        }
        let size = 2;
        if (next === 91) {
          let end = offset + 2;
          while (end < bytes.length && ((bytes[end] ?? 0) < 64 || (bytes[end] ?? 0) > 126)) end++;
          if (end === bytes.length) {
            this.escapePrefix = Buffer.from(bytes.subarray(offset));
            this.escapeTimer = setTimeout(() => {
              const pending = this.escapePrefix;
              this.clearEscapeTimer();
              if (pending.length > 0) this.write(pending);
            }, 30);
            return;
          }
          size = end - offset + 1;
        } else if (offset + 2 === bytes.length) {
          this.escapePrefix = Buffer.from(bytes.subarray(offset));
          this.escapeTimer = setTimeout(() => {
            const pending = this.escapePrefix;
            this.clearEscapeTimer();
            if (pending.length > 0) this.write(pending);
          }, 30);
          return;
        } else {
          size = 3;
        }
        this.write(bytes.subarray(offset, offset + size));
        offset += size;
        continue;
      }

      if (byte === 10 || byte === 13) {
        this.submitted = true;
        this.afterCR = byte === 13 && offset + 1 === bytes.length;
        this.write(bytes.subarray(offset, offset + 1));
        return;
      }

      const start = offset;
      while (
        offset < bytes.length &&
        bytes[offset] !== 10 &&
        bytes[offset] !== 13 &&
        !(this.escapeHandler !== undefined && bytes[offset] === 27)
      ) {
        offset += 1;
      }
      this.write(bytes.subarray(start, offset));
    }
  };

  private readonly ended = (): void => {
    const pending = this.escapePrefix;
    this.clearEscapeTimer();
    if (pending.length > 0) this.write(pending);
    this.end();
  };

  private readonly failed = (error: Error): void => {
    this.destroy(error);
  };
}
