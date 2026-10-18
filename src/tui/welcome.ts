import { displayWidth, fitLine, fitLineTail, terminalText } from "./text.js";

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
const RESET = "\u001b[0m";

/**
 * Compact first frame: identity, active model/workspace, and setup only when
 * the user needs to act. Full session detail stays available through commands.
 * It never takes the alternate screen or steals scrollback.
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
  const detailsWidth = Math.max(1, width - 2);
  const details = `${terminalText(options.provider)} · ${terminalText(options.model)} · `;
  const availablePathWidth = detailsWidth - Math.min(displayWidth(details), detailsWidth - 1);
  const pathWidth = Math.min(detailsWidth - 1, Math.max(9, availablePathWidth));
  const lines = [
    `◆ chivgent v${options.version}${options.resumed ? " · resumed" : ""}`,
    `${fitLine(details, Math.max(1, detailsWidth - pathWidth))}${fitLineTail(options.cwd, pathWidth)}`,
    ...(setup === undefined ? [] : [setup]),
  ];
  return `\n${lines.map((line, index) => {
    const fitted = fitLine(line, width);
    if (!options.color || fitted.length === 0) return fitted;
    if (index === 0) return `${COLOR}${fitted}${RESET}`;
    return fitted;
  }).join("\n")}\n`;
}
