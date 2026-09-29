import { PassThrough } from "node:stream";

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
};

const menuKeys = new Map<string, "up" | "down" | "enter" | "escape" | "tab">([
  ["\u001b[A", "up"], ["\u001bOA", "up"], ["\u001b[B", "down"], ["\u001bOB", "down"],
  ["\r", "enter"], ["\n", "enter"], ["\u001b", "escape"], ["\t", "tab"],
]);

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
  private escapePrefix = Buffer.alloc(0);
  private escapeTimer?: NodeJS.Timeout;
  private beforeEdit?: () => void;
  private menuKey?: (key: "up" | "down" | "enter" | "escape" | "tab") => boolean;

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

  setMenuControls(beforeEdit: () => void, menuKey: (key: "up" | "down" | "enter" | "escape" | "tab") => boolean): void {
    this.beforeEdit = beforeEdit;
    this.menuKey = menuKey;
  }

  /** Called only when the REPL is ready to read its next line. */
  acceptLine(): void {
    this.submitted = false;
  }

  markSubmitted(): void {
    this.submitted = true;
  }

  dispose(): void {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.source.off("data", this.receive);
    this.source.off("end", this.ended);
    this.source.off("error", this.failed);
    this.setRawMode(false);
    this.source.pause();
    this.destroy();
  }

  private readonly receive = (chunk: Buffer | string): void => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.escapePrefix.length > 0) {
      bytes = Buffer.concat([this.escapePrefix, bytes]);
      this.escapePrefix = Buffer.alloc(0);
      if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    if (bytes.length === 0) return;
    if (this.afterCR && bytes[0] === 10) bytes = bytes.subarray(1);
    this.afterCR = false;
    if (bytes.length === 0) return;
    if (this.busy || this.submitted) {
      if (bytes.includes(3)) this.write("\u0003");
      return;
    }

    // A terminal may deliver Arrow+Enter in one chunk. Parse control keys in
    // order, while forwarding ordinary text as intact bytes for split UTF-8.
    let offset = 0;
    const forward = (part: Buffer): void => {
      if (part.length === 0) return;
      this.beforeEdit?.();
      this.write(part);
    };
    const holdEscape = (part: Buffer): void => {
      this.escapePrefix = Buffer.from(part);
      this.escapeTimer = setTimeout(() => {
        const pending = this.escapePrefix;
        this.escapePrefix = Buffer.alloc(0);
        this.escapeTimer = undefined;
        if (pending.length === 1 && this.menuKey?.("escape")) return;
        forward(pending);
      }, 30);
    };
    while (offset < bytes.length && !this.submitted) {
      const byte = bytes[offset];
      if (byte === 27 || byte === 9 || byte === 10 || byte === 13) {
        let size = 1;
        if (byte === 27) {
          if (offset + 1 === bytes.length) { holdEscape(bytes.subarray(offset)); return; }
          if (bytes[offset + 1] === 91) {
            let end = offset + 2;
            while (end < bytes.length && ((bytes[end] ?? 0) < 64 || (bytes[end] ?? 0) > 126)) end++;
            if (end === bytes.length) { holdEscape(bytes.subarray(offset)); return; }
            size = end - offset + 1;
          } else if (bytes[offset + 1] === 79) {
            if (offset + 2 === bytes.length) { holdEscape(bytes.subarray(offset)); return; }
            size = 3;
          }
        }
        const part = bytes.subarray(offset, offset + size);
        const key = menuKeys.get(part.toString());
        if (key !== undefined && this.menuKey?.(key)) {
          offset += size;
          continue;
        }
        if (byte === 10 || byte === 13) {
          this.submitted = true;
          this.afterCR = byte === 13 && offset + 1 === bytes.length;
          forward(part);
          return;
        }
        forward(part);
        offset += size;
        continue;
      }
      const start = offset;
      while (offset < bytes.length && ![9, 10, 13, 27].includes(bytes[offset] ?? -1)) offset++;
      forward(bytes.subarray(start, offset));
    }
  };

  private readonly ended = (): void => {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    if (this.escapePrefix.length > 0) this.write(this.escapePrefix);
    this.end();
  };
  private readonly failed = (error: Error): void => { this.destroy(error); };
}
