import type { TurnEndEvent } from "../events.js";
import { formatTokens } from "../providers/usage.js";
import { toolTranscript } from "./activity.js";
import { spinnerFrame } from "./animation.js";
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
  readonly animate?: boolean;
}

export type LayoutLine =
  | { readonly kind: "text"; readonly plain: string }
  | {
      readonly kind: "plan";
      readonly plain: string;
      readonly indent: string;
      readonly prefix: string;
      readonly detail: string;
    }
  | {
      readonly kind: "tool";
      readonly plain: string;
      readonly indent: string;
      readonly spinner: string;
      readonly separator: string;
      readonly head: string;
      readonly tail: string;
    }
  | { readonly kind: "overflow"; readonly plain: string }
  | {
      readonly kind: "status";
      readonly plain: string;
      readonly spinner?: string;
      readonly gap?: string;
      readonly label?: string;
      readonly rest: string;
    };

function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function toolHeadParts(
  tool: RunningTool,
  now: number,
  width: number,
  spinner: string,
): { readonly head: string; readonly tail: string; readonly plain: string } | undefined {
  const lead = `  ${spinner} `;
  const name = terminalText(tool.name);
  const prefix = `${lead}${name}`;
  const duration = ` (${elapsed(tool.startedAt, now)})`;
  if (displayWidth(prefix) + displayWidth(duration) > width) {
    const plain = fitLine(prefix, width);
    return plain.startsWith(lead) ? { head: plain.slice(lead.length), tail: "", plain } : undefined;
  }
  const targetWidth = tool.target === undefined
    ? 0
    : width - displayWidth(prefix) - displayWidth(duration) - 1;
  if (targetWidth >= 2) {
    const head = `${name} ${fitLineTail(tool.target!, targetWidth)}`;
    return { head, tail: duration, plain: `${lead}${head}${duration}` };
  }
  const plain = fitLine(`${prefix}${duration}`, width);
  if (!plain.startsWith(lead)) return undefined;
  const tail = plain.endsWith(duration) ? duration : "";
  return {
    head: plain.slice(lead.length, plain.length - tail.length),
    tail,
    plain,
  };
}

function describeTool(tool: RunningTool, now: number, width: number, spinner: string): LayoutLine {
  const lead = `  ${spinner} `;
  // Preserve the tool name, the end of a long path, and the latest progress.
  const latest = terminalText(tool.progress.split("\n").filter((line) => line.length > 0).at(-1) ?? "");
  const makeLine = (
    parts: { readonly head: string; readonly tail: string; readonly plain: string } | undefined,
    progress = "",
  ): LayoutLine => {
    if (parts === undefined) {
      return { kind: "overflow", plain: fitLine(`${lead}${terminalText(tool.name)}`, width) };
    }
    return {
      kind: "tool",
      plain: `${parts.plain}${progress}`,
      indent: "  ",
      spinner,
      separator: " ",
      head: parts.head,
      tail: `${parts.tail}${progress}`,
    };
  };

  const fullHead = toolHeadParts(tool, now, width, spinner);
  if (latest.length === 0) return makeLine(fullHead);
  if (fullHead !== undefined && displayWidth(fullHead.plain) + 2 + displayWidth(latest) <= width) {
    return makeLine(fullHead, `  ${latest}`);
  }
  const progressWidth = Math.max(6, Math.floor(width * 0.35));
  if (width - progressWidth < 14) return makeLine(fullHead);
  const compactHead = toolHeadParts(tool, now, width - progressWidth - 2, spinner);
  if (compactHead === undefined) return makeLine(fullHead);
  return makeLine(compactHead, `  ${fitLineTail(latest, progressWidth)}`);
}

function statusLabels(status: NonNullable<ViewState["run"]>["status"]): {
  readonly full: string;
  readonly short: string;
} {
  switch (status) {
    case "thinking":
      return { full: "thinking", short: "thinking" };
    case "responding":
      return { full: "responding", short: "writing" };
    case "running-tools":
      return { full: "running tools", short: "tools" };
  }
}

function makeStatusLine(
  label: string,
  parts: readonly string[],
  separator: string,
  spinner?: string,
): LayoutLine {
  const rest = parts.length === 0 ? "" : `${separator}${parts.join(separator)}`;
  const plain = spinner === undefined ? `${label}${rest}` : `${spinner} ${label}${rest}`;
  return {
    kind: "status",
    plain,
    ...(spinner === undefined ? {} : { spinner, gap: " " }),
    label,
    rest,
  };
}

function statusLine(
  run: NonNullable<ViewState["run"]>,
  now: number,
  width: number,
  animate: boolean,
): LayoutLine {
  const { full: status, short: shortStatus } = statusLabels(run.status);
  const spinner = animate ? spinnerFrame(now - run.startedAt) : undefined;
  const duration = elapsed(run.startedAt, now);
  const usage = run.usage;
  const tokens = usage !== undefined && usage.usage.totalTokens > 0
    ? `${formatTokens(usage.usage.totalTokens)} tokens${usage.complete ? "" : "+"}`
    : undefined;
  const failed = run.failedTools ?? 0;
  const failureNote = failed > 0 ? `${failed} failed` : undefined;

  const fullTailCandidates: readonly (readonly string[])[] = [
    [`turn ${run.turn}/${run.maxTurns}`, ...(failureNote === undefined ? [] : [failureNote]), duration, ...(tokens === undefined ? [] : [tokens]), "ctrl+c to stop"],
    [`turn ${run.turn}/${run.maxTurns}`, duration, ...(tokens === undefined ? [] : [tokens]), "ctrl+c to stop"],
    [`turn ${run.turn}/${run.maxTurns}`, duration, "ctrl+c to stop"],
    [`${run.turn}/${run.maxTurns}`, duration, "^C stop"],
    [duration, "^C stop"],
  ];

  const candidates: LayoutLine[] = [];
  if (spinner !== undefined) {
    for (const parts of fullTailCandidates) {
      candidates.push(makeStatusLine(status, parts, "  ·  ", spinner));
    }
    candidates.push(makeStatusLine(shortStatus, [duration, "^C stop"], "  ·  ", spinner));
    candidates.push(makeStatusLine(shortStatus, [duration, "^C stop"], "  ·  "));
    candidates.push(makeStatusLine(shortStatus, ["^C stop"], "  ·  ", spinner));
    candidates.push(makeStatusLine(shortStatus, ["^C stop"], " ", spinner));
  } else {
    for (const parts of fullTailCandidates) {
      candidates.push(makeStatusLine(status, parts, "  ·  "));
    }
    candidates.push(makeStatusLine(shortStatus, [duration, "^C stop"], "  ·  "));
  }
  candidates.push(makeStatusLine(shortStatus, ["^C stop"], "  ·  "));
  candidates.push(makeStatusLine(shortStatus, ["^C stop"], " "));
  candidates.push(makeStatusLine(shortStatus, ["^C"], " "));

  for (const candidate of candidates) {
    if (displayWidth(candidate.plain) <= width) return candidate;
  }
  const fallback = fitLine("^C stop", width);
  return { kind: "status", plain: fallback, rest: fallback };
}

/**
 * Computes structured layout lines before ANSI styling so styling never
 * affects line clipping, width accounting, or untrusted text sanitization.
 */
export function layoutView(
  state: ViewState,
  options: ViewOptions,
): readonly LayoutLine[] {
  const run = state.run;
  if (run === undefined) {
    return [];
  }

  const animate = options.animate ?? true;
  const elapsedMs = options.now - run.startedAt;
  const lines: LayoutLine[] = [];

  const tail = run.text.split("\n").filter((line) => line.length > 0).slice(-MAX_TEXT_LINES);
  for (const line of tail) {
    lines.push({ kind: "text", plain: fitLineTail(line, options.width) });
  }

  if (run.plan !== undefined) {
    const steps = run.plan.plan;
    const done = steps.filter(step => step.status === "completed").length;
    const active = steps.find(step => step.status === "in_progress");
    const prefix = `Plan ${done}/${steps.length}`;
    const raw = `  ${prefix}${active === undefined ? "" : ` · ${terminalText(active.step)}`}`;
    const plain = fitLine(raw, options.width);
    if (plain.startsWith(`  ${prefix}`)) {
      lines.push({
        kind: "plan",
        plain,
        indent: "  ",
        prefix,
        detail: plain.slice(2 + prefix.length),
      });
    } else {
      lines.push({ kind: "overflow", plain });
    }
  }

  const listed = run.running.slice(0, MAX_LISTED_TOOLS);
  for (let index = 0; index < listed.length; index += 1) {
    const tool = listed[index]!;
    const spinner = animate ? spinnerFrame(elapsedMs, index * 2) : "↳";
    lines.push(describeTool(tool, options.now, options.width, spinner));
  }
  const hidden = run.running.length - MAX_LISTED_TOOLS;
  if (hidden > 0) {
    lines.push({ kind: "overflow", plain: fitLine(`  and ${hidden} more`, options.width) });
  }

  lines.push(statusLine(run, options.now, options.width, animate));

  return lines.slice(-Math.max(1, options.height ?? lines.length));
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
  return layoutView(state, options).map(line => line.plain);
}

/**
 * What a finished turn leaves behind in the terminal's own scrollback.
 *
 * Derived from the event rather than from the state, because by the time this
 * is wanted the state has already been cleared — and because the event carries
 * the authoritative message either way.
 */
export function transcriptLines(event: TurnEndEvent, width = 120): readonly string[] {
  const lines: string[] = [];
  // A result carries no arguments, so the target comes from the call that
  // produced it — the same join by call id the eval runner makes.
  lines.push(...toolTranscript(event.message.toolCalls, event.toolResults, width));
  if (event.message.content.trim().length > 0) {
    lines.push(event.message.content);
  }
  return lines;
}
