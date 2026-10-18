import { fitLine, fitLineTail } from "./text.js";

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

const COLOR = "\u001b[1;36m";
const RESET = "\u001b[0m";

/**
 * Compact first frame: brand, workspace path, and one setup hint when the
 * user must set a provider, model, or endpoint. The active provider and model
 * are drawn under the composer. This frame never takes the alternate screen
 * or steals scrollback.
 */
export function welcome(options: WelcomeOptions): string {
  const width = Math.max(1, options.width - 1);
  const setup = options.setupIssue === "model"
    ? "Set a model with /model MODEL"
    : options.setupIssue === "base-url"
      ? "Set the API URL with /endpoint URL"
      : options.signedOut
        ? "Set up a Provider with /provider"
        : undefined;
  // The path uses the whole line: the full path when it fits, the tail when
  // it does not. It is not shortened to ~.
  const lines = [
    `◆ chivgent v${options.version}${options.resumed ? " · resumed" : ""}`,
    fitLineTail(options.cwd, width),
    ...(setup === undefined ? [] : [setup]),
  ];
  return `\n${lines.map((line, index) => {
    const fitted = fitLine(line, width);
    if (!options.color || fitted.length === 0) return fitted;
    if (index === 0) return `${COLOR}${fitted}${RESET}`;
    return fitted;
  }).join("\n")}\n`;
}
