import { fitLine, terminalText } from "./text.js";

/**
 * Small terminal-focused renderer. No HTML, no remote resource fetching,
 * no third-party ANSI, and no regex-based mutation of displayed source code.
 * This deliberately handles only headings, quotes, lists and fenced code.
 */
export function formatTerminalMarkdown(markdown: string, columns = 80, color = false): string {
  const width = Math.max(1, columns - 1);
  const lines = terminalText(markdown).split("\n");
  let fenced = false;
  const rendered: string[] = [];

  for (const line of lines) {
    const fence = /^\s*```([^\s`]*)\s*$/.exec(line);
    if (fence !== null) {
      if (!fenced) {
        const lang = fence[1] ?? "";
        const header = fitLine(`  ┌─ ${lang || "code"}`, width);
        rendered.push(color ? `\u001b[2m${header}\u001b[0m` : header);
      } else {
        const footer = fitLine("  └─", width);
        rendered.push(color ? `\u001b[2m${footer}\u001b[0m` : footer);
      }
      fenced = !fenced;
      continue;
    }

    if (fenced) {
      const body = fitLine(`  │ ${line}`, width);
      rendered.push(color ? `\u001b[36m${body}\u001b[0m` : body);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const title = fitLine(`${" ".repeat(Math.max(0, heading[1]!.length - 1))}${heading[2]}`, width);
      rendered.push(color ? `\u001b[1m${title}\u001b[0m` : title);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    if (bullet !== null) {
      rendered.push(fitLine(`${bullet[1]}• ${bullet[2]}`, width));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const content = fitLine(`┃ ${quote[1]}`, width);
      rendered.push(color ? `\u001b[2m${content}\u001b[0m` : content);
      continue;
    }

    rendered.push(fitLine(line, width));
  }
  return rendered.join("\n");
}
