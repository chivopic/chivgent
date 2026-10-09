import { StringDecoder } from "node:string_decoder";
import { EditorDocument, EditorPainter, editorFrame, type EditorOutput } from "./editor.js";

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
  private searching = false;
  private searchQuery = "";
  private searchOffset = 0;
  readonly exitRequested = { value: false };
  private readonly maxWidth: () => number;
  private readonly maxHeight: () => number;

  constructor(
    output: EditorOutput,
    private readonly done: (text: string | undefined) => void,
    private readonly options: { readonly submitOnEnter?: boolean; readonly history?: readonly string[] } = {},
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
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    this.pending += this.decoder.write(chunk);
    this.parse();
    if (!this.completed) this.draw();
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

  private parse(): void {
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
    };

    while (this.pending.length > 0 && !this.completed) {
      if (this.pasting) {
        const index = this.pending.indexOf(endPaste);
        if (index !== -1) {
          this.document.insert(this.pending.slice(0, index));
          this.pending = this.pending.slice(index + endPaste.length);
          this.pasting = false;
          continue;
        }
        // Leave enough bytes to recognize a terminator split across chunks.
        const safe = Math.max(0, this.pending.length - endPaste.length);
        if (safe > 0) {
          this.document.insert(this.pending.slice(0, safe));
          this.pending = this.pending.slice(safe);
        }
        break;
      }
      if (this.pending.startsWith(startPaste)) {
        this.pasting = true;
        this.pending = this.pending.slice(startPaste.length);
        continue;
      }
      if (this.pending[0] === "\u001b") {
        const matched = Object.keys(escapes).find(sequence => this.pending.startsWith(sequence));
        if (matched !== undefined) {
          escapes[matched]?.();
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
        continue;
      }
      const char = this.pending[0] ?? "";
      this.pending = this.pending.slice(1);
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
          return;
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
            return;
          }
          if (!this.previousCR) this.document.insert("\n");
          this.previousCR = false;
          break;
        case "\u000f": this.document.insert("\n"); break; // Ctrl+O: newline when Enter submits.
        case "\u0013": // Ctrl+S submits once, with no implicit shell action.
          this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
          return;
        case "\u0001": this.document.home(); break; // Ctrl+A
        case "\u0005": this.document.end(); break; // Ctrl+E
        case "\u0008":
        case "\u007f": this.document.backspace(); break;
        case "\r":
          if (this.options.submitOnEnter) {
            this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
            return;
          }
          this.document.insert("\n");
          this.previousCR = true;
          break;
        case "\t":
          this.document.insert("  ");
          this.previousCR = false;
          break;
        default:
          this.previousCR = false;
          if (char >= " " && char !== "\u007f") this.document.insert(char);
      }
    }
  }

  private draw(): void {
    this.painter.render(editorFrame(this.document, this.maxWidth(), this.maxHeight(), this.options.submitOnEnter === true));
  }

  cancel(): void {
    this.finish(undefined);
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
