import { displayWidth, fitLine, fitLineTail, terminalText } from "./text.js";

export interface WelcomeOptions {
  readonly version: string;
  readonly provider: string;
  readonly model?: string;
  readonly cwd: string;
  readonly resumed: boolean;
  readonly signedOut: boolean;
  readonly setupIssue?: "model" | "base-url";
  readonly width: number;
  readonly color?: boolean;
}

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const BOLD_CYAN = "\u001b[1;36m";

const WORDMARK_LEFT = [
  "╔═╗ ╦ ╦ ╦ ╦  ╦",
  "║   ╠═╣ ║ ╚╗╔╝",
  "╚═╝ ╩ ╩ ╩  ╚╝ ",
] as const;

const WORDMARK_RIGHT = [
  " ╔═╗ ╔═╗ ╔╗╔ ╔╦╗",
  " ║ ╦ ║╣  ║║║  ║ ",
  " ╚═╝ ╚═╝ ╝╚╝  ╩ ",
] as const;

function setupHint(options: WelcomeOptions): string | undefined {
  if (options.setupIssue === "model") return "Set a model with /model MODEL";
  if (options.setupIssue === "base-url") return "Set the API URL with /endpoint URL";
  if (options.signedOut) return "Set up a Provider with /provider";
  return undefined;
}

function paint(value: string, code: string, color: boolean): string {
  return color && value.length > 0 ? `${code}${value}${RESET}` : value;
}

/**
 * First-frame entry: wide terminals render the two-tone CHIVGENT geometric
 * wordmark with workspace context; narrow terminals keep a compact 2-3 line
 * header. Never includes active provider, model, or session ID, and never
 * takes the alternate screen.
 */
export function welcome(options: WelcomeOptions): string {
  const usableWidth = Math.max(1, options.width - 1);
  const color = options.color === true;
  const cleanVersion = terminalText(options.version).replace(/\n/g, " ");
  const setup = setupHint(options);
  const meta = `   v${cleanVersion}${options.resumed ? " · resumed" : ""}`;
  const row2Plain = `  ${WORDMARK_LEFT[2]}${WORDMARK_RIGHT[2]}${meta}`;

  if (usableWidth >= 42 && displayWidth(row2Plain) <= usableWidth) {
    const wordmarkRows = WORDMARK_LEFT.map((left, index) => {
      const right = WORDMARK_RIGHT[index]!;
      const tail = index === 2 ? meta : "";
      if (!color) return `  ${left}${right}${tail}`;
      return `  ${BOLD_CYAN}${left}${RESET}${BOLD}${right}${RESET}${paint(tail, DIM, true)}`;
    });
    const path = fitLineTail(options.cwd, Math.max(1, usableWidth - 4));
    const pathLine = color ? `  ${CYAN}◆${RESET} ${DIM}${path}${RESET}` : `  ◆ ${path}`;
    const hintLine = setup === undefined ? [] : [paint(fitLine(`  → ${setup}`, usableWidth), YELLOW, color)];
    return `\n${[...wordmarkRows, "", pathLine, ...hintLine].join("\n")}\n`;
  }

  // The path uses the whole line: the full path when it fits, the tail when
  // it does not. It is not shortened to ~.
  const title = fitLine(`◆ chivgent v${cleanVersion}${options.resumed ? " · resumed" : ""}`, usableWidth);
  const path = fitLineTail(options.cwd, usableWidth);
  const hint = setup === undefined ? undefined : fitLine(setup, usableWidth);
  const lines = [
    paint(title, BOLD_CYAN, color),
    paint(path, DIM, color),
    ...(hint === undefined ? [] : [paint(hint, YELLOW, color)]),
  ];
  return `\n${lines.join("\n")}\n`;
}
