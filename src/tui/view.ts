import type { TurnEndEvent } from "../events.js";
import { formatTokens } from "../providers/usage.js";
import { callTarget } from "../tools/target.js";
import type { RunningTool, ViewState } from "./state.js";

/** Tools listed individually before the rest are summarised as a count. */
const MAX_LISTED_TOOLS = 3;
/** Lines of the answer kept visible while it streams. */
const MAX_TEXT_LINES = 3;
const MINIMUM_WIDTH = 20;

export interface ViewOptions {
  readonly width: number;
  readonly now: number;
}

function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Cuts to the width, marking the cut so a truncated line never reads as whole. */
function fit(line: string, width: number): string {
  const usable = Math.max(MINIMUM_WIDTH, width);
  return line.length <= usable ? line : `${line.slice(0, usable - 1)}…`;
}

function describeTool(tool: RunningTool, now: number): string {
  const head = tool.target === undefined ? tool.name : `${tool.name} ${tool.target}`;
  // The newest line of a tool's output says more than its first, and a running
  // command's interesting output is at the end.
  const latest = tool.progress.split("\n").filter((line) => line.length > 0).at(-1);
  const suffix = latest === undefined ? "" : `  ${latest}`;
  return `  ${head} (${elapsed(tool.startedAt, now)})${suffix}`;
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

  const tail = run.text.split("\n").slice(-MAX_TEXT_LINES);
  for (const line of tail) {
    if (line.length > 0) {
      lines.push(fit(line, options.width));
    }
  }

  for (const tool of run.running.slice(0, MAX_LISTED_TOOLS)) {
    lines.push(fit(describeTool(tool, options.now), options.width));
  }
  const hidden = run.running.length - MAX_LISTED_TOOLS;
  if (hidden > 0) {
    lines.push(`  and ${hidden} more`);
  }

  const status = [
    run.status === "thinking" ? "thinking" : "running tools",
    `turn ${run.turn}/${run.maxTurns}`,
    elapsed(run.startedAt, options.now),
  ];
  if (run.usage !== undefined && run.usage.usage.totalTokens > 0) {
    status.push(
      `${formatTokens(run.usage.usage.totalTokens)} tokens${run.usage.complete ? "" : "+"}`,
    );
  }
  status.push("ctrl+c to stop");
  lines.push(fit(status.join("  ·  "), options.width));

  return lines;
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
