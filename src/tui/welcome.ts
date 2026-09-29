import { fitLine, fitLineTail } from "./text.js";

export interface WelcomeOptions {
  readonly version: string;
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly resumed: boolean;
  readonly signedOut: boolean;
  readonly setupIssue?: "model" | "base-url";
  readonly width: number;
  readonly color?: boolean;
}

const glyphs: Record<string, readonly string[]> = {
  C: ["█▀▀", "█  ", "█▄▄"], H: ["█ █", "█▀█", "█ █"], I: ["█", "█", "█"],
  V: ["█ █", "█ █", " ▀ "], G: ["█▀▀", "█ ▄", "█▄█"], E: ["█▀▀", "█▀ ", "█▄▄"],
  N: ["█▄█", "█▀█", "█ █"], T: ["▀█▀", " █ ", " █ "],
};
const wordmark = [0, 1, 2].map((row) => [..."CHIVGENT"].map((letter) => glyphs[letter]?.[row] ?? "").join(" "));

export function welcome(options: WelcomeOptions): string {
  const width = Math.max(1, options.width - 1);
  const brand = width >= 38 ? wordmark.map((row) => `  ${row}`) : ["  ◆ chivgent"];
  const lines = [
    ...brand,
    `  v${options.version}${options.resumed ? "  ·  continued session" : ""}`,
    `  ${options.provider} / ${options.model}`,
    `  ${fitLineTail(options.cwd, width - 2)}`,
    options.setupIssue === "model"
      ? "  Set a model with /model MODEL"
      : options.setupIssue === "base-url"
        ? "  Set the API URL with /endpoint URL"
        : options.signedOut
          ? "  Start with /provider → choose a Provider"
          : "  Ready. Type a task or use /provider to switch.",
    "  / commands  ·  ↑↓ select  ·  Ctrl+C exit",
  ];
  return `\n${lines.map((line, index) => {
    const fitted = fitLine(line, width);
    return options.color && index < brand.length ? `\u001b[1;36m${fitted}\u001b[0m` : fitted;
  }).join("\n")}\n\n`;
}
