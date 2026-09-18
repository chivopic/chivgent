import { displayWidth, fitLine } from "./text.js";

export interface WelcomeOptions {
  readonly version: string;
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly signedOut: boolean;
  readonly width: number;
}

export function welcome(options: WelcomeOptions): string {
  const width = Math.max(1, Math.min(88, options.width - 1));
  const content = [
    `chivgent ${options.version}  ·  coding assistant`,
    `${options.provider} / ${options.model}`,
    `Workspace  ${options.cwd}`,
    `${options.resumed ? "Resumed" : "Session"}    ${options.sessionId}`,
    "",
    options.signedOut ? "Run /login to add your API key." : "Ready. Describe what you want to build.",
    "Tab commands · ↑ history · Ctrl+C stop · Ctrl+D exit",
  ];
  if (width < 12) {
    return `${content.map((line) => fitLine(line, width)).join("\n")}\n`;
  }
  const inner = width - 4;
  const lines = content.map((line) => {
    const fitted = fitLine(line, inner);
    return `│ ${fitted}${" ".repeat(inner - displayWidth(fitted))} │`;
  });
  return [
    `╭${"─".repeat(width - 2)}╮`,
    ...lines,
    `╰${"─".repeat(width - 2)}╯`,
    "",
  ].join("\n");
}
