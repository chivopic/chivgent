import { StringDecoder } from "node:string_decoder";
import { EditorDocument, EditorPainter, editorFrame, type EditorOutput } from "./editor.js";
import { slashSuggestions, type SlashSuggestion } from "./slash.js";

export interface EditorControllerOptions {
  readonly history?: readonly string[];
  readonly slashCommands?: readonly SlashSuggestion[];
  readonly footerStatus?: () => string | undefined;
  /** Active provider and model. Omitted when either one is not set. */
  readonly footerIdentity?: () => string | undefined;
  readonly color?: boolean;
  readonly onShiftTab?: () => Promise<void> | void;
}

/**
 * Keyboard-only parser for the inline rounded composer.
 * Never enables terminal mouse tracking so native selection and scrollback
 * continue to work undisturbed.
 */
export class EditorController {
  readonly document = new EditorDocument();
  private readonly decoder = new StringDecoder("utf8");
  private readonly painter: EditorPainter;
  private pending = "";
  private pasting = false;
  private escapeTimer?: NodeJS.Timeout;
  private completed = false;
  private completionIndex = 0;
  private dismissedCommand?: string;
  private historyIndex?: number;
  private historyDraft = "";
  private modeSwitchPending = false;
  private modeSwitchCancelPending = false;
  private modeSwitchQueue: Buffer[] = [];
  private modeSwitchQueueBytes = 0;
  readonly exitRequested = { value: false };
  private readonly maxWidth: () => number;
  private readonly maxHeight: () => number;

  constructor(
    output: EditorOutput,
    private readonly done: (text: string | undefined) => void,
    private readonly options: EditorControllerOptions = {},
  ) {
    this.painter = new EditorPainter(output);
    this.maxWidth = () => Math.max(8, output.columns ?? 80);
    this.maxHeight = () => Math.max(6, output.rows ?? 24);
  }

  begin(): void {
    this.draw();
  }

  resized(): void {
    if (!this.completed) this.draw();
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

  cancel(): void {
    if (this.modeSwitchPending) {
      this.modeSwitchCancelPending = true;
      this.modeSwitchQueue = [];
      this.modeSwitchQueueBytes = 0;
      return;
    }
    this.finish(undefined);
  }

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
    this.historyIndex = undefined;
    return true;
  }

  private navigateVertical(direction: -1 | 1): void {
    const matches = this.suggestions();
    if (matches.length > 0) {
      this.completionIndex = Math.max(0, Math.min(matches.length - 1, this.completionIndex + direction));
      return;
    }
    const history = this.options.history ?? [];
    if (direction < 0 && this.document.position.row === 0 && history.length > 0) {
      if (this.historyIndex === undefined) {
        this.historyDraft = this.document.text;
        this.historyIndex = history.length - 1;
      } else {
        this.historyIndex = Math.max(0, this.historyIndex - 1);
      }
      this.document.loadDraft(history[this.historyIndex]!);
      this.dismissedCommand = undefined;
      this.completionIndex = 0;
      return;
    }
    if (direction > 0 && this.historyIndex !== undefined &&
        this.document.position.row === this.document.text.split("\n").length - 1) {
      if (this.historyIndex < history.length - 1) {
        this.historyIndex += 1;
        this.document.loadDraft(history[this.historyIndex]!);
      } else {
        this.historyIndex = undefined;
        this.document.loadDraft(this.historyDraft);
      }
      this.dismissedCommand = undefined;
      this.completionIndex = 0;
      return;
    }
    this.document.moveVertical(direction);
  }

  private triggerShiftTab(): void {
    if (this.modeSwitchPending) return;
    this.modeSwitchPending = true;
    Promise.resolve().then(() => this.options.onShiftTab?.()).catch(error => {
      this.document.warning = `Could not change mode: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => {
      this.modeSwitchPending = false;
      if (this.completed) return;
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
    });
  }

  private parse(): boolean {
    let changed = false;
    const startPaste = "\u001b[200~";
    const endPaste = "\u001b[201~";
    const escapes: Record<string, () => void> = {
      "\u001b[A": () => this.navigateVertical(-1),
      "\u001bOA": () => this.navigateVertical(-1),
      "\u001b[B": () => this.navigateVertical(1),
      "\u001bOB": () => this.navigateVertical(1),
      "\u001b[C": () => this.document.right(),
      "\u001b[D": () => this.document.left(),
      "\u001b[H": () => this.document.home(),
      "\u001b[F": () => this.document.end(),
      "\u001b[1~": () => this.document.home(),
      "\u001b[4~": () => this.document.end(),
      "\u001b[3~": () => {
        this.document.delete();
        this.historyIndex = undefined;
      },
      "\u001bOH": () => this.document.home(),
      "\u001bOF": () => this.document.end(),
      ...(this.options.onShiftTab === undefined ? {} : {
        "\u001b[Z": () => this.triggerShiftTab(),
      }),
    };

    while (this.pending.length > 0 && !this.completed && !this.modeSwitchPending) {
      if (this.pasting) {
        const index = this.pending.indexOf(endPaste);
        if (index !== -1) {
          this.document.insert(this.pending.slice(0, index));
          this.historyIndex = undefined;
          changed = true;
          this.pending = this.pending.slice(index + endPaste.length);
          this.pasting = false;
          continue;
        }
        // Leave enough bytes to recognize a terminator split across chunks.
        const safe = Math.max(0, this.pending.length - endPaste.length);
        if (safe > 0) {
          this.document.insert(this.pending.slice(0, safe));
          this.historyIndex = undefined;
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
        const matched = Object.keys(escapes).find(sequence => this.pending.startsWith(sequence));
        if (matched !== undefined) {
          changed = true;
          escapes[matched]?.();
          this.pending = this.pending.slice(matched.length);
          continue;
        }
        if (this.pending === "\u001b" || this.pending.startsWith("\u001b[") ||
            this.pending.startsWith("\u001bO") || startPaste.startsWith(this.pending)) {
          // An isolated Escape dismisses suggestions or cancels, after briefly waiting for split CSI sequences.
          if (this.pending.length < 16) {
            this.escapeTimer = setTimeout(() => {
              if (this.pending === "\u001b") {
                if (this.suggestions().length > 0) {
                  this.dismissedCommand = this.document.text;
                  this.pending = "";
                  this.draw();
                } else {
                  this.finish(undefined);
                }
              } else {
                this.pending = "";
                this.draw();
              }
            }, 40);
            break;
          }
        }
        // Unknown CSI/ESC sequence: discard its bytes without corrupting the draft.
        const end = this.pending.slice(1).search(/[A-Za-z~]/);
        this.pending = end < 0 ? "" : this.pending.slice(end + 2);
        changed = true;
        continue;
      }

      const char = this.pending[0] ?? "";
      this.pending = this.pending.slice(1);
      changed = true;
      switch (char) {
        case "\u0003": // Ctrl+C clears/cancels only this draft, not the REPL.
          this.finish(undefined);
          return changed;
        case "\u0004": // Ctrl+D exits only when the draft is empty.
          if (this.document.text.length === 0) {
            this.exitRequested.value = true;
            this.finish(undefined);
          }
          break;
        case "\u001a": // Ctrl+Z
          this.document.undo();
          this.historyIndex = undefined;
          break;
        case "\u0019": // Ctrl+Y
          this.document.redo();
          this.historyIndex = undefined;
          break;
        case "\u000a": // LF / Ctrl+J
          this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
          return changed;
        case "\u000f": // Ctrl+O inserts a newline inside the draft.
          this.document.insert("\n");
          this.historyIndex = undefined;
          break;
        case "\u0001": this.document.home(); break; // Ctrl+A
        case "\u0005": this.document.end(); break; // Ctrl+E
        case "\u0008":
        case "\u007f":
          this.document.backspace();
          this.historyIndex = undefined;
          break;
        case "\r":
          if (this.suggestions().length > 0 &&
              !this.suggestions().some(item => `/${item.value}` === this.document.text)) {
            this.insertSelectedCompletion();
            break;
          }
          this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
          return changed;
        case "\t":
          if (this.insertSelectedCompletion()) break;
          this.document.insert("  ");
          this.historyIndex = undefined;
          break;
        default:
          if (char >= " " && char !== "\u007f") {
            this.document.insert(char, true);
            this.dismissedCommand = undefined;
            this.completionIndex = 0;
            this.historyIndex = undefined;
          }
      }
    }
    return changed;
  }

  private draw(): void {
    const matches = this.suggestions();
    this.completionIndex = matches.length > 0 ? Math.min(this.completionIndex, matches.length - 1) : 0;
    const footerStatus = this.options.footerStatus?.();
    const footerIdentity = this.options.footerIdentity?.();
    const frame = editorFrame(this.document, this.maxWidth(), this.maxHeight(), {
      suggestions: matches,
      selectedSuggestion: this.completionIndex,
      ...(footerStatus === undefined ? {} : { footerStatus }),
      color: this.options.color === true,
      ...(footerIdentity === undefined ? {} : { footerIdentity }),
    });
    this.painter.render(frame);
  }

  private finish(value: string | undefined): void {
    if (this.completed) return;
    this.completed = true;
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.painter.finish();
    this.done(value);
  }
}
