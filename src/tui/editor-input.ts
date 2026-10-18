import { StringDecoder } from "node:string_decoder";
import { EditorDocument, EditorPainter, editorFrame, type EditorOutput, type EditorFrame } from "./editor.js";
import { slashSuggestions, type SlashSuggestion } from "./slash.js";

const MOUSE_ENABLE = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_DISABLE = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";

/**
 * Key parser for the modal editor. The active TuiInput raw hook gives this
 * parser exclusive ownership; neither readline nor slash completion sees the
 * editor's keystrokes.
 */
export class EditorController {
  readonly document = new EditorDocument();
  private readonly decoder = new StringDecoder("utf8");
  private readonly painter: EditorPainter;
  private pending = "";
  private pasting = false;
  private escapeTimer?: NodeJS.Timeout;
  private completed = false;
  private previousCR = false;
  private completionIndex = 0;
  private dismissedCommand?: string;
  private lastFrame?: EditorFrame;
  private originRow?: number;
  private mouseDragging = false;
  private mouseSuspended = false;
  private exitRestore?: () => void;
  private modeSwitchPending = false;
  private modeSwitchCancelPending = false;
  private modeSwitchQueue: Buffer[] = [];
  private modeSwitchQueueBytes = 0;
  private searching = false;
  private searchQuery = "";
  private searchOffset = 0;
  readonly exitRequested = { value: false };
  private readonly maxWidth: () => number;
  private readonly maxHeight: () => number;

  constructor(
    private readonly output: EditorOutput,
    private readonly done: (text: string | undefined) => void,
    private readonly options: {
      readonly submitOnEnter?: boolean;
      readonly history?: readonly string[];
      readonly slashCommands?: readonly SlashSuggestion[];
      readonly mouse?: boolean;
      readonly footerStatus?: () => string | undefined;
      readonly color?: boolean;
      readonly onShiftTab?: () => Promise<void> | void;
    } = {},
  ) {
    this.painter = new EditorPainter(output);
    this.maxWidth = () => Math.max(8, output.columns ?? 80);
    this.maxHeight = () => Math.max(6, output.rows ?? 24);
  }

  begin(): void {
    if (this.options.mouse) {
      this.painterMouse(true);
      this.installExitRestore();
    }
    this.draw();
  }

  private painterMouse(enabled: boolean): void {
    // Opt-in only while editor owns the terminal; restore normal selection on exit.
    this.outputWrite(enabled ? MOUSE_ENABLE : MOUSE_DISABLE);
  }

  private installExitRestore(): void {
    if (this.exitRestore !== undefined) return;
    const restore = (): void => {
      try { this.outputWrite(MOUSE_DISABLE); } catch { /* the terminal may already be gone */ }
    };
    this.exitRestore = restore;
    process.once("exit", restore);
  }

  private removeExitRestore(): void {
    if (this.exitRestore === undefined) return;
    process.off("exit", this.exitRestore);
    this.exitRestore = undefined;
  }

  /** Hand the wheel to the terminal so its own scrollback moves. */
  private suspendMouseTracking(): void {
    if (!this.options.mouse || this.mouseSuspended) return;
    this.mouseSuspended = true;
    this.originRow = undefined;
    this.mouseDragging = false;
    this.painterMouse(false);
  }

  private resumeMouseTracking(): void {
    if (!this.options.mouse || !this.mouseSuspended) return;
    this.mouseSuspended = false;
    this.originRow = undefined;
    this.painterMouse(true);
  }

  private outputWrite(chunk: string): void { this.output.write(chunk); }

  private suggestions(): readonly SlashSuggestion[] {
    if (this.dismissedCommand === this.document.text) return [];
    return slashSuggestions(this.document.text, this.document.cursor, this.options.slashCommands ?? []);
  }

  private insertSelectedCompletion(): boolean {
    const matches = this.suggestions();
    const match = matches[this.completionIndex % matches.length];
    if (match === undefined) return false;
    this.document.loadDraft(`/${match.value}`);
    this.dismissedCommand = this.document.text;
    this.completionIndex = 0;
    return true;
  }

  /** True only when the rendered frame needs repainting. */
  private processMouse(sequence: string): boolean {
    const answer = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
    if (answer === null) return false;
    if (this.mouseSuspended) return false;
    const button = Number(answer[1]);
    const column = Number(answer[2]);
    const row = Number(answer[3]);
    if ((button & 64) !== 0) {
      // Wheel over a visible completion changes the selection; over a draft row
      // it moves the caret. Anywhere else belongs to the terminal's scrollback.
      if (answer[4] !== "M") return false;
      if ((button & 2) !== 0) return false;
      const direction = (button & 1) === 0 ? -1 : 1;
      const frameRow = this.frameRowAt(row);
      if (frameRow !== undefined) {
        const suggestion = this.lastFrame?.suggestionRows?.find(item => item.row === frameRow);
        if (suggestion !== undefined && column >= 1 && column <= this.maxWidth()) {
          const max = this.suggestions().length - 1;
          this.completionIndex = Math.max(0, Math.min(max, this.completionIndex + direction * 3));
          return true;
        }
        const inputRow = this.lastFrame?.inputRows?.[frameRow - 1];
        if (inputRow !== undefined) {
          for (let i = 0; i < 3; i += 1) this.document.moveVertical(direction);
          return true;
        }
        // Outside the draft and its menu: hand wheel-up to the terminal.
        if (direction < 0) this.suspendMouseTracking();
        return false;
      }
      // No frame mapping yet: preserve the existing fallback.
      for (let i = 0; i < 3; i += 1) this.document.moveVertical(direction);
      return true;
    }
    if (button === 0 && answer[4] === "m") {
      const wasDragging = this.mouseDragging;
      this.mouseDragging = false;
      return wasDragging;
    }
    if (button !== 0 && button !== 32) return false;
    if (button === 32 && !this.mouseDragging) return false;
    if (this.originRow === undefined || this.lastFrame === undefined) return false;
    if (column < 1 || column > this.maxWidth()) return false;
    const relative = row - 1 - this.originRow;
    const commandRow = this.lastFrame.suggestionRows?.find(item => item.row === relative);
    if (button === 0 && answer[4] === "M" && commandRow !== undefined) {
      this.completionIndex = commandRow.commandIndex;
      this.insertSelectedCompletion();
      return true;
    }
    const inputRow = this.lastFrame.inputRows?.[relative - 1];
    // Only visible editable rows map to document text; header, popup and footer
    // coordinates must never be interpreted as text positions.
    if (inputRow === undefined) return false;
    const frameColumn = Math.max(0, column - 1 - inputRow.gutterCells);
    const visibleTextColumn = inputRow.scrollCells > 0
      ? Math.max(0, frameColumn - 1)
      : frameColumn;
    this.document.placeAt(
      inputRow.documentRow,
      visibleTextColumn + inputRow.scrollCells,
      button === 32,
    );
    this.mouseDragging = true;
    return true;
  }

  private frameRowAt(screenRow: number): number | undefined {
    if (this.originRow === undefined || this.lastFrame === undefined) return undefined;
    return screenRow - 1 - this.originRow;
  }

  resized(): void {
    if (this.completed) return;
    // A resize invalidates the mapping and needs a repaint. Take the mouse back
    // so the new frame can be hit-tested.
    this.resumeMouseTracking();
    this.originRow = undefined;
    this.draw();
  }

  receive(chunk: Buffer): void {
    if (this.completed) return;
    if (this.modeSwitchPending) {
      if (chunk.includes(3)) {
        this.modeSwitchQueue = [];
        this.modeSwitchQueueBytes = 0;
        this.modeSwitchCancelPending = true;
      } else if (this.modeSwitchQueueBytes + chunk.length <= 64 * 1024) {
        this.modeSwitchQueue.push(Buffer.from(chunk));
        this.modeSwitchQueueBytes += chunk.length;
      } else {
        this.modeSwitchQueue = [];
        this.modeSwitchQueueBytes = 0;
        this.document.warning = "Input buffer full while changing mode; queued input was discarded.";
      }
      return;
    }
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    this.pending += this.decoder.write(chunk);
    const changed = this.parse();
    if (!this.completed && changed) this.draw();
  }

  private updateSearch(): void {
    const history = this.options.history ?? [];
    const matches = [...history].reverse().filter(value =>
      value.toLowerCase().includes(this.searchQuery.toLowerCase()));
    if (matches.length === 0) {
      this.document.warning = `History: no match for ${this.searchQuery}`;
      return;
    }
    this.searchOffset = Math.min(this.searchOffset, matches.length - 1);
    const match = matches[this.searchOffset] ?? "";
    this.document.warning = `History ${this.searchOffset + 1}/${matches.length}: ${match.replace(/\n/g, " ↵ ").slice(0, 70)}`;
  }

  private parse(): boolean {
    let changed = false;
    const startPaste = "\u001b[200~";
    const endPaste = "\u001b[201~";
    const escapes: Record<string, () => void> = {
      "\u001b[A": () => this.document.moveVertical(-1),
      "\u001b[B": () => this.document.moveVertical(1),
      "\u001b[C": () => this.document.right(),
      "\u001b[D": () => this.document.left(),
      "\u001b[H": () => this.document.home(),
      "\u001b[F": () => this.document.end(),
      "\u001b[1~": () => this.document.home(),
      "\u001b[4~": () => this.document.end(),
      "\u001b[3~": () => this.document.delete(),
      "\u001bOH": () => this.document.home(),
      "\u001bOF": () => this.document.end(),
      ...(this.options.submitOnEnter && this.options.onShiftTab !== undefined ? {
        "\u001b[Z": () => {
          if (this.modeSwitchPending) return;
          this.modeSwitchPending = true;
          Promise.resolve().then(() => this.options.onShiftTab?.()).catch(error => {
            this.document.warning = `Could not change mode: ${error instanceof Error ? error.message : String(error)}`;
          }).finally(() => {
            this.modeSwitchPending = false;
            if (!this.completed) {
              if (this.modeSwitchCancelPending) {
                this.modeSwitchCancelPending = false;
                this.modeSwitchQueue = [];
                this.modeSwitchQueueBytes = 0;
                this.finish(undefined);
                return;
              }
              this.parse();
              const queued = this.modeSwitchQueue;
              this.modeSwitchQueue = [];
              this.modeSwitchQueueBytes = 0;
              for (const chunk of queued) this.receive(chunk);
              if (!this.completed) this.draw();
            }
          });
        },
      } : {}),
    };

    while (this.pending.length > 0 && !this.completed && !this.modeSwitchPending) {
      if (this.mouseSuspended) {
        // While suspended, consume in-flight mouse and cursor-position reports
        // without repainting. The first real input takes the mouse back.
        const report = /^\u001b\[<\d+;\d+;\d+[Mm]|^\u001b\[\d+;\d+R/.exec(this.pending);
        if (report !== null) {
          this.pending = this.pending.slice(report[0].length);
          continue;
        }
        if (this.pending === "\u001b" || this.pending === "\u001b[" || this.pending === "\u001bO" ||
            /^\u001b\[<[\d;]*$/.test(this.pending) || /^\u001b\[\d+(;\d+)?$/.test(this.pending)) {
          // Hold a chunked report or a real Escape for the usual short window.
          if (this.pending.length < 16) {
            this.escapeTimer = setTimeout(() => {
              if (this.pending === "\u001b") {
                this.pending = "";
                this.finish(undefined);
              } else {
                this.pending = "";
                this.draw();
              }
            }, 40);
            break;
          }
        }
        this.resumeMouseTracking();
        changed = true;
      }
      if (this.pasting) {
        const index = this.pending.indexOf(endPaste);
        if (index !== -1) {
          this.document.insert(this.pending.slice(0, index));
          changed = true;
          this.pending = this.pending.slice(index + endPaste.length);
          this.pasting = false;
          continue;
        }
        // Leave enough bytes to recognize a terminator split across chunks.
        const safe = Math.max(0, this.pending.length - endPaste.length);
        if (safe > 0) {
          this.document.insert(this.pending.slice(0, safe));
          changed = true;
          this.pending = this.pending.slice(safe);
        }
        break;
      }
      if (this.pending.startsWith(startPaste)) {
        this.pasting = true;
        changed = true;
        this.pending = this.pending.slice(startPaste.length);
        continue;
      }
      if (this.pending[0] === "\u001b") {
        const dsr = /^\u001b\[(\d+);(\d+)R/.exec(this.pending);
        if (dsr !== null) {
          if (this.lastFrame !== undefined) this.originRow = Number(dsr[1]) - 1 - this.lastFrame.cursorRow;
          this.pending = this.pending.slice(dsr[0].length);
          continue;
        }
        const mouse = /^\u001b\[<\d+;\d+;\d+[Mm]/.exec(this.pending);
        if (mouse !== null) {
          if (this.processMouse(mouse[0])) changed = true;
          this.pending = this.pending.slice(mouse[0].length);
          continue;
        }
        const matched = Object.keys(escapes).find(sequence => this.pending.startsWith(sequence));
        if (matched !== undefined) {
          if (matched === "\u001b[Z" && this.searching) {
            this.pending = this.pending.slice(matched.length);
            continue;
          }
          changed = true;
          if (this.suggestions().length > 0 && (matched === "\u001b[A" || matched === "\u001b[B")) {
            const matches = this.suggestions();
            this.completionIndex = Math.max(0, Math.min(matches.length - 1,
              this.completionIndex + (matched === "\u001b[B" ? 1 : -1)));
          } else escapes[matched]?.();
          this.pending = this.pending.slice(matched.length);
          continue;
        }
        if (this.pending === "\u001b" || this.pending.startsWith("\u001b[") ||
            this.pending.startsWith("\u001bO") || startPaste.startsWith(this.pending)) {
          // An isolated Escape means cancel, but wait briefly for split CSI
          // arrows and bracketed-paste delimiters.
          if (this.pending.length < 16) {
            this.escapeTimer = setTimeout(() => {
              if (this.pending === "\u001b") {
                if (this.searching) {
                  this.searching = false;
                  this.pending = "";
                  this.document.warning = "";
                  this.draw();
                } else if (this.suggestions().length > 0) {
                  this.dismissedCommand = this.document.text;
                  this.pending = "";
                  this.draw();
                } else this.finish(undefined);
              }
              else {
                this.pending = "";
                this.draw();
              }
            }, 40);
            break;
          }
        }
        // Unknown CSI: discard its bytes, not executable escape controls.
        const end = this.pending.slice(1).search(/[A-Za-z~]/);
        this.pending = end < 0 ? "" : this.pending.slice(end + 2);
        changed = true;
        continue;
      }
      const char = this.pending[0] ?? "";
      this.pending = this.pending.slice(1);
      changed = true;
      if (this.searching) {
        if (char === "\r" || char === "\n") {
          const match = [...(this.options.history ?? [])].reverse().filter(value =>
            value.toLowerCase().includes(this.searchQuery.toLowerCase()))[this.searchOffset];
          if (match !== undefined) this.document.loadDraft(match);
          this.searching = false;
          this.document.warning = "";
        } else if (char === "\u0003" || char === "\u001b") {
          this.searching = false;
          this.document.warning = "";
        } else if (char === "\u0012") {
          this.searchOffset += 1;
          this.updateSearch();
        } else if (char === "\u007f" || char === "\b") {
          this.searchQuery = this.searchQuery.slice(0, -1);
          this.searchOffset = 0;
          this.updateSearch();
        } else if (char >= " ") {
          this.searchQuery += char;
          this.searchOffset = 0;
          this.updateSearch();
        }
        continue;
      }
      switch (char) {
        case "\u0003": // Ctrl+C cancels only this editor, not the REPL.
          this.finish(undefined);
          return changed;
        case "\u0004": // Ctrl+D exits an empty default composer.
          if (this.document.text.length === 0) {
            this.exitRequested.value = true;
            this.finish(undefined);
          }
          break;
        case "\u0012": // Ctrl+R: interactive reverse search through user prompts.
          this.searching = true;
          this.searchQuery = "";
          this.searchOffset = 0;
          this.updateSearch();
          break;
        case "\u001a": this.document.undo(); break; // Ctrl+Z
        case "\u0019": this.document.redo(); break; // Ctrl+Y
        case "\u000a": // Ctrl+J when emitted by terminals (same byte as LF).
          if (this.options.submitOnEnter) {
            this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
            return changed;
          }
          if (!this.previousCR) this.document.insert("\n");
          this.previousCR = false;
          break;
        case "\u000f": this.document.insert("\n"); break; // Ctrl+O: newline when Enter submits.
        case "\u0013": // Ctrl+S submits once, with no implicit shell action.
          this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
          return changed;
        case "\u0001": this.document.home(); break; // Ctrl+A
        case "\u0005": this.document.end(); break; // Ctrl+E
        case "\u0008":
        case "\u007f": this.document.backspace(); break;
        case "\r":
          if (this.suggestions().length > 0 &&
              !this.suggestions().some(item => `/${item.value}` === this.document.text)) {
            this.insertSelectedCompletion();
            break;
          }
          if (this.options.submitOnEnter) {
            this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
            return changed;
          }
          this.document.insert("\n");
          this.previousCR = true;
          break;
        case "\t":
          if (this.insertSelectedCompletion()) break;
          this.document.insert("  ");
          this.previousCR = false;
          break;
        default:
          this.previousCR = false;
          if (char >= " " && char !== "\u007f") {
            this.document.insert(char, true);
            this.dismissedCommand = undefined;
            this.completionIndex = 0;
          }
      }
    }
    return changed;
  }

  private draw(): void {
    if (this.mouseSuspended) return;
    const matches = this.suggestions();
    this.completionIndex = matches.length > 0 ? Math.min(this.completionIndex, matches.length - 1) : 0;
    const frame = editorFrame(this.document, this.maxWidth(), this.maxHeight(), this.options.submitOnEnter === true,
      matches, this.completionIndex, this.options.footerStatus?.(), this.options.color === true);
    this.lastFrame = frame;
    this.painter.render(frame);
    if (this.options.mouse) {
      // The painter keeps the frame's top row anchored across redraws. A resize
      // invalidates that mapping; resized() clears it before requesting a new DSR.
      this.outputWrite("\u001b[6n");
    }
  }

  cancel(): void {
    if (this.modeSwitchPending) {
      this.modeSwitchCancelPending = true;
      this.modeSwitchQueue = [];
      this.modeSwitchQueueBytes = 0;
      return;
    }
    this.finish(undefined);
  }

  private finish(value: string | undefined): void {
    if (this.completed) return;
    this.completed = true;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.painter.finish();
    if (this.options.mouse) {
      this.painterMouse(false);
      this.removeExitRestore();
    }
    this.mouseSuspended = false;
    this.done(value);
  }
}
