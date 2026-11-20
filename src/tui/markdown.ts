import { displayWidth, fitLine, terminalText } from "./text.js";
import { highlightCodeLine } from "./syntax.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap complete graphemes without replacing or discarding answer text. */
function wrap(text: string, width: number, words: boolean): string[] {
  const lines: string[] = [];
  const segments = Array.from(graphemes.segment(text), item => item.segment);
  let start = 0;
  while (start < segments.length) {
    let end = start;
    let used = 0;
    let breakAfter = start;
    while (end < segments.length) {
      const segment = segments[end]!;
      const cells = displayWidth(segment);
      if (end > start && used + cells > width) break;
      used += cells;
      end += 1;
      if (/\s/u.test(segment)) breakAfter = end;
    }
    if (words && end < segments.length && breakAfter > start) end = breakAfter;
    lines.push(segments.slice(start, end).join(""));
    start = end;
  }
  return lines.length === 0 ? [""] : lines;
}

function wrapped(text: string, width: number, prefix: string, continuation = prefix, words = true): string[] {
  // Tiny terminals cannot accommodate a gutter; retain the text instead.
  const first = displayWidth(prefix) < width ? prefix : "";
  const rest = displayWidth(continuation) < width ? continuation : "";
  const available = Math.max(1, width - Math.max(displayWidth(first), displayWidth(rest)));
  return wrap(text, available, words).map((line, index) => `${index === 0 ? first : rest}${line}`);
}

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
      const language = this.fenced;
      return wrapped(line, width, "  │ ", "  │ ", false).map((row) => {
        if (!this.color) return row;
        const prefix = row.startsWith("  │ ") ? "  │ " : "";
        return `${prefix ? `\u001b[36m${prefix}\u001b[0m` : ""}${highlightCodeLine(row.slice(prefix.length), language)}`;
      }).join("\n");
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const title = wrapped(heading[2]!, width, " ".repeat(heading[1]!.length));
      return title.map(row => this.color ? `\u001b[1m${row}\u001b[0m` : row).join("\n");
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    if (bullet !== null) {
      const prefix = ` ${bullet[1]}• `;
      return wrapped(bullet[2]!, width, prefix, " ".repeat(displayWidth(prefix))).join("\n");
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const content = wrapped(quote[1]!, width, " ┃ ");
      return content.map(row => this.color ? `\u001b[2m${row}\u001b[0m` : row).join("\n");
    }

    return line.length === 0 ? "" : wrapped(line, width, " ").join("\n");
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
