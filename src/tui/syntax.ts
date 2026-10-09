import { terminalText } from "./text.js";

const supported = new Set([
  "js", "jsx", "javascript", "ts", "tsx", "typescript",
  "python", "py", "rust", "rs", "bash", "sh", "shell", "json",
]);
const keywords = new Set([
  "const", "let", "var", "function", "return", "async", "await",
  "if", "else", "for", "while", "break", "continue", "class",
  "extends", "import", "export", "from", "default", "new", "try",
  "catch", "throw", "switch", "case", "type", "interface", "readonly",
  "public", "private", "static", "def", "lambda", "pass", "yield",
  "elif", "with", "as", "in", "is", "not", "and", "or", "fn",
  "impl", "struct", "enum", "mod", "pub", "use", "mut", "match",
  "trait", "self", "print", "echo", "then", "fi", "done",
]);
const literals = new Set(["true", "false", "null", "undefined", "None", "True", "False", "Some", "Ok", "Err"]);

/**
 * Conservative tokenizer for terminal presentation only.
 * No dynamic grammar loading, user ANSI, filesystem access or execution.
 */
export function highlightCodeLine(input: string, language: string): string {
  const line = terminalText(input).replace(/\n/g, " ");
  if (!supported.has(language.toLowerCase())) return line;
  const pattern = /\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_][A-Za-z_0-9]*\b|\b\d+(?:\.\d+)?\b/g;
  let result = "";
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    const token = match[0];
    result += line.slice(offset, index);
    let color: string | undefined;
    if (token.startsWith("//") || token.startsWith("#")) color = "2";
    else if (/^["'`]/.test(token)) color = "32";
    else if (keywords.has(token)) color = "94";
    else if (literals.has(token) || /^\d/.test(token)) color = "33";
    result += color === undefined ? token : `\u001b[${color}m${token}\u001b[0m`;
    offset = index + token.length;
  }
  return result + line.slice(offset);
}
