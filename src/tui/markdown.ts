import { fitLine, terminalText } from "./text.js";
import { highlightCodeLine } from "./syntax.js";

/**
 * Small terminal-focused renderer. No HTML, no remote resource fetching,
 * no third-party ANSI, and no regex-based mutation of displayed source code.
 * This deliberately handles only headings, quotes, lists and fenced code.
 */
export class StreamingMarkdownFormatter {
  private fenced?: string;

  constructor(
    private readonly columns: () => number,
    private readonly color = false,
  ) {}

  formatLine(rawLine: string): string {
    const width = Math.max(1, this.columns() - 1);
    const line = terminalText(rawLine);
    const fence = /^\s*```([^\s`]*)\s*$/.exec(line);
    if (fence !== null) {
      if (this.fenced === undefined) {
        const lang = fence[1] ?? "";
        this.fenced = lang;
        const header = fitLine(`  ┌─ ${lang || "code"}`, width);
        return this.color ? `\u001b[2m${header}\u001b[0m` : header;
      }
      this.fenced = undefined;
      const footer = fitLine("  └─", width);
      return this.color ? `\u001b[2m${footer}\u001b[0m` : footer;
    }

    if (this.fenced !== undefined) {
      const body = fitLine(line, Math.max(1, width - 4));
      return this.color ? `\u001b[36m  │ \u001b[0m${highlightCodeLine(body, this.fenced)}` : `  │ ${body}`;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const title = fitLine(`${" ".repeat(Math.max(0, heading[1]!.length - 1))}${heading[2]}`, width);
      return this.color ? `\u001b[1m${title}\u001b[0m` : title;
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    if (bullet !== null) {
      return fitLine(`${bullet[1]}• ${bullet[2]}`, width);
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const content = fitLine(`┃ ${quote[1]}`, width);
      return this.color ? `\u001b[2m${content}\u001b[0m` : content;
    }

    return fitLine(line, width);
  }

  reset(): void {
    this.fenced = undefined;
  }
}

/**
 * Small terminal-focused renderer. No HTML, no remote resource fetching,
 * no third-party ANSI, and no regex-based mutation of displayed source code.
 * This deliberately handles only headings, quotes, lists and fenced code.
 */
export function formatTerminalMarkdown(markdown: string, columns = 80, color = false): string {
  const formatter = new StreamingMarkdownFormatter(() => columns, color);
  return terminalText(markdown).split("\n").map(line => formatter.formatLine(line)).join("\n");
}
