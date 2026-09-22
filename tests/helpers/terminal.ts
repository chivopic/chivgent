import { PassThrough } from "node:stream";
import xterm from "@xterm/headless";

export class TerminalInput extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(enabled: boolean): this { this.raw = enabled; return this; }
}

/** A real terminal parser: assertions see cells after cursor controls execute. */
export function terminalHarness(cols = 80, rows = 24) {
  const terminal = new xterm.Terminal({ cols, rows, convertEol: true, allowProposedApi: true });
  const input = new TerminalInput();
  const output = Object.assign(new PassThrough(), { columns: cols, rows, isTTY: true });
  let bytes = "";
  output.on("data", (chunk: Buffer) => {
    bytes += chunk.toString();
    terminal.write(chunk);
  });
  const flush = () => new Promise<void>((resolve) => terminal.write("", resolve));
  const visible = () => Array.from({ length: terminal.rows }, (_, row) =>
    terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) ?? "",
  );
  const history = () => Array.from({ length: terminal.buffer.active.length }, (_, row) =>
    terminal.buffer.active.getLine(row)?.translateToString(true) ?? "",
  );
  return {
    terminal, input, output, flush, visible, history, bytes: () => bytes,
    resize(columns: number, height: number) {
      terminal.resize(columns, height);
      output.columns = columns;
      output.rows = height;
      output.emit("resize");
    },
    dispose() { input.end(); output.destroy(); terminal.dispose(); },
  };
}
