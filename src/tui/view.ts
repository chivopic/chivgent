import type { TurnEndEvent } from "../events.js";
import { formatTokens } from "../providers/usage.js";
import { callTarget } from "../tools/target.js";
import { displayWidth, fitLine, fitLineTail, terminalText } from "./text.js";
import type { RunningTool, ViewState } from "./state.js";

/** Tools listed individually before the rest are summarised as a count. */
const MAX_LISTED_TOOLS = 3;
/** Lines of the answer kept visible while it streams. */
const MAX_TEXT_LINES = 3;


export interface ViewOptions {
  readonly width: number;
  readonly now: number;
  readonly height?: number;
}

function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function toolHead(tool: RunningTool, now: number, width: number): string {
  const prefix = `  ${terminalText(tool.name)}`;
  const duration = ` (${elapsed(tool.startedAt, now)})`;
  if (displayWidth(prefix) + displayWidth(duration) > width) return fitLine(prefix, width);
  if (tool.target === undefined) return fitLine(`${prefix}${duration}`, width);
  const targetWidth = width - displayWidth(prefix) - displayWidth(duration) - 1;
  if (targetWidth < 2) return fitLine(`${prefix}${duration}`, width);
  return `${prefix} ${fitLineTail(tool.target, targetWidth)}${duration}`;
}

function describeTool(tool: RunningTool, now: number, width: number): string {
  // Preserve the tool name, the end of a long path, and the latest progress.
  const latest = terminalText(tool.progress.split("\n").filter((line) => line.length > 0).at(-1) ?? "");
  if (latest.length === 0) return toolHead(tool, now, width);
  const fullHead = toolHead(tool, now, width);
  if (displayWidth(fullHead) + 2 + displayWidth(latest) <= width) {
    return `${fullHead}  ${latest}`;
  }
  const progressWidth = Math.max(6, Math.floor(width * 0.35));
  if (width - progressWidth < 14) return fullHead;
  return `${toolHead(tool, now, width - progressWidth - 2)}  ${fitLineTail(latest, progressWidth)}`;
}

function statusLine(run: NonNullable<ViewState["run"]>, now: number, width: number): string {
  const status = run.status === "thinking" ? "thinking" : "running tools";
  const shortStatus = run.status === "thinking" ? "thinking" : "tools";
  const duration = elapsed(run.startedAt, now);
  const usage = run.usage;
  const tokens = usage !== undefined && usage.usage.totalTokens > 0
    ? `${formatTokens(usage.usage.totalTokens)} tokens${usage.complete ? "" : "+"}`
    : undefined;
  const candidates = [
    [status, `turn ${run.turn}/${run.maxTurns}`, duration, ...(tokens === undefined ? [] : [tokens]), "ctrl+c to stop"],
    [status, `turn ${run.turn}/${run.maxTurns}`, duration, "ctrl+c to stop"],
    [status, `${run.turn}/${run.maxTurns}`, duration, "^C stop"],
    [status, duration, "^C stop"],
    [shortStatus, duration, "^C stop"],
    [shortStatus, "^C stop"],
  ];
  for (const parts of candidates) {
    const line = parts.join("  ·  ");
    if (displayWidth(line) <= width) return line;
  }
  for (const line of [`${shortStatus} ^C stop`, `${shortStatus} ^C`]) {
    if (displayWidth(line) <= width) return line;
  }
  return fitLine("^C stop", width);
}

/**
 * Renders the live region. Pure: no terminal, no clock, no colour.
 *
 * Colour is left to the painter so this stays comparable line by line — an
 * escape sequence in the middle of a string makes "did this line change" a
 * question about bytes rather than about content.
 */
export function view(
  state: ViewState,
  options: ViewOptions,
): readonly string[] {
  const run = state.run;
  if (run === undefined) {
    return [];
  }

  const lines: string[] = [];

  const tail = run.text.split("\n").filter((line) => line.length > 0).slice(-MAX_TEXT_LINES);
  for (const line of tail) {
    lines.push(fitLineTail(line, options.width));
  }

  for (const tool of run.running.slice(0, MAX_LISTED_TOOLS)) {
    lines.push(describeTool(tool, options.now, options.width));
  }
  const hidden = run.running.length - MAX_LISTED_TOOLS;
  if (hidden > 0) {
    lines.push(fitLine(`  and ${hidden} more`, options.width));
  }

  lines.push(statusLine(run, options.now, options.width));

  return lines.slice(-Math.max(1, options.height ?? lines.length));
}

/**
 * What a finished turn leaves behind in the terminal's own scrollback.
 *
 * Derived from the event rather than from the state, because by the time this
 * is wanted the state has already been cleared — and because the event carries
 * the authoritative message either way.
 */
export function transcriptLines(event: TurnEndEvent): readonly string[] {
  const lines: string[] = [];
  // A result carries no arguments, so the target comes from the call that
  // produced it — the same join by call id the eval runner makes.
  const calls = new Map(event.message.toolCalls.map((call) => [call.id, call]));
  for (const result of event.toolResults) {
    const target = callTarget(calls.get(result.toolCallId)?.arguments);
    const head = target === undefined ? result.toolName : `${result.toolName} ${target}`;
    lines.push(`  ${head}${result.isError ? " (failed)" : ""}`);
  }
  if (event.message.content.trim().length > 0) {
    lines.push(event.message.content);
  }
  return lines;
}
