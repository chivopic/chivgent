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
  private readonly maxWidth: () => number;
  private readonly maxHeight: () => number;

  constructor(
    output: EditorOutput,
    private readonly done: (text: string | undefined) => void,
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
              if (this.pending === "\u001b") this.finish(undefined);
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
      switch (char) {
        case "\u0003": // Ctrl+C cancels only this editor, not the REPL.
          this.finish(undefined);
          return;
        case "\u0013": // Ctrl+S submits once, with no implicit shell action.
          this.finish(this.document.text.trim().length > 0 ? this.document.text : undefined);
          return;
        case "\u0001": this.document.home(); break; // Ctrl+A
        case "\u0005": this.document.end(); break; // Ctrl+E
        case "\u0008":
        case "\u007f": this.document.backspace(); break;
        case "\r":
          this.document.insert("\n");
          this.previousCR = true;
          break;
        case "\n":
          if (!this.previousCR) this.document.insert("\n");
          this.previousCR = false;
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
    this.painter.render(editorFrame(this.document, this.maxWidth(), this.maxHeight()));
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
