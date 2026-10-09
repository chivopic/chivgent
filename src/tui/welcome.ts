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

const COLOR = "\u001b[1;36m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/**
 * Calm first frame, inspired by the hierarchy of mature coding CLIs:
 * recognizable product, model and workspace, one next action, then shortcuts.
 * It never takes the alternate screen or steals scrollback.
 */
export function welcome(options: WelcomeOptions): string {
  const width = Math.max(1, options.width - 1);
  const wide = width >= 42;
  const brand = wide
    ? "  ◆ chivgent"
    : "  ◆ chivgent";
  const start = options.setupIssue === "model"
    ? "Set a model with /model MODEL"
    : options.setupIssue === "base-url"
      ? "Set the API URL with /endpoint URL"
      : options.signedOut
        ? "Start with /provider → choose a Provider"
        : "Ready. Describe a task to begin.";
  const model = `${options.provider}  ·  ${options.model}`;
  const lines = [
    brand,
    `  v${options.version}${options.resumed ? "  ·  resumed session" : ""}`,
    "",
    `  ${fitLine(model, Math.max(1, width - 2))}`,
    `  ${fitLineTail(options.cwd, Math.max(1, width - 2))}`,
    "",
    `  ${start}`,
    `  / commands  ·  Tab complete  ·  Ctrl+C stop/exit`,
  ];
  return `\n${lines.map((line, index) => {
    const fitted = fitLine(line, width);
    if (!options.color || fitted.length === 0) return fitted;
    if (index === 0) return `${COLOR}${fitted}${RESET}`;
    if (index === 1 || index === 4 || index === 7) return `${DIM}${fitted}${RESET}`;
    return fitted;
  }).join("\n")}\n\n`;
}
