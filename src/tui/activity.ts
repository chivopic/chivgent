import type { ToolCall, ToolResultMessage } from "../messages.js";
import { parsePatch } from "../patch/parse.js";
import { callTarget } from "../tools/target.js";
import { fitLine, terminalText } from "./text.js";

const MAX_DIFF_LINES = 6;
const MAX_DIFF_SNIPPET_LINES = 4;
const MAX_DETAIL_LINE = 120;

function short(value: string, width: number): string {
  return fitLine(terminalText(value), Math.max(1, width));
}

function briefFailure(result: ToolResultMessage): string {
  const lines = result.content.split("\n").filter(line => line.trim().length > 0);
  const status = result.toolName === "bash"
    ? lines.findLast(line => /(?:Command exited with code|timed out|unavailable)/i.test(line))
    : undefined;
  return short(status ?? lines[0] ?? "failed", 100);
}

function isReadTool(name: string): boolean {
  return name === "read_file" || name === "list_files" || name === "search_text";
}

function displayName(name: string): string {
  const names: Record<string, string> = {
    read_file: "Read", list_files: "Listed", search_text: "Searched",
    edit_file: "Edited", write_file: "Wrote", apply_patch: "Patched",
    bash: "Shell",
  };
  return names[name] ?? name;
}

function recordLine(call: ToolCall | undefined, result: ToolResultMessage, width: number): string {
  const target = callTarget(call?.arguments);
  const description = target === undefined
    ? displayName(result.toolName)
    : `${displayName(result.toolName)} ${target}`;
  const text = result.isError
    ? `  ! ${description} — ${briefFailure(result)}`
    : `  ✓ ${description}`;
  return short(text, width);
}

function patchDetails(call: ToolCall, width: number): readonly string[] {
  if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
    return [];
  }
  const args = call.arguments as Record<string, unknown>;
  if (typeof args.patch !== "string") return [];
  try {
    const changes = parsePatch(args.patch);
    const results: string[] = [];
    let added = 0;
    let removed = 0;
    for (const change of changes) {
      if (change.kind === "add") {
        added += change.lines.length;
        results.push(`    + ${change.path} (new file, +${change.lines.length})`);
      } else if (change.kind === "delete") {
        results.push(`    - ${change.path} (deleted)`);
      } else {
        const plus = change.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
        const minus = change.hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
        added += plus;
        removed += minus;
        results.push(`    ~ ${change.path} (+${plus}/-${minus})`);
      }
    }
    const header = `    ${changes.length} file${changes.length === 1 ? "" : "s"} · +${added}/-${removed}`;
    const diff = args.patch.split("\n").filter(line => line.startsWith("+") || line.startsWith("-"));
    const snippet = diff.slice(0, MAX_DIFF_SNIPPET_LINES).map(line => short(`      ${line}`, width));
    return [
      short(header, width),
      ...results.slice(0, MAX_DIFF_LINES).map(line => short(line, width)),
      ...(results.length > MAX_DIFF_LINES
        ? [short(`    … and ${results.length - MAX_DIFF_LINES} more files`, width)]
        : []),
      ...snippet,
      ...(diff.length > MAX_DIFF_SNIPPET_LINES
        ? [short(`      … ${diff.length - MAX_DIFF_SNIPPET_LINES} more diff lines`, width)]
        : []),
    ];
  } catch {
    return [];
  }
}

/** A bounded, outcome-oriented summary of one completed tool batch. */
export function toolTranscript(
  calls: readonly ToolCall[],
  results: readonly ToolResultMessage[],
  width = MAX_DETAIL_LINE,
): readonly string[] {
  const byId = new Map(calls.map(call => [call.id, call]));
  const lines: string[] = [];
  let readCount = 0;
  let readFailures = 0;
  const flushReadGroup = (): void => {
    if (readCount === 0) return;
    if (readCount >= 3 && readFailures === 0) {
      lines.push(short(`  ✓ Explored ${readCount} locations`, width));
    } else {
      for (const read of pendingReads) lines.push(recordLine(byId.get(read.toolCallId), read, width));
    }
    pendingReads.length = 0;
    readCount = 0;
    readFailures = 0;
  };
  const pendingReads: ToolResultMessage[] = [];

  for (const result of results) {
    if (isReadTool(result.toolName)) {
      pendingReads.push(result);
      readCount += 1;
      if (result.isError) readFailures += 1;
      continue;
    }
    flushReadGroup();
    const call = byId.get(result.toolCallId);
    lines.push(recordLine(call, result, width));
    if (!result.isError && result.toolName === "apply_patch" && call !== undefined) {
      lines.push(...patchDetails(call, width));
    }
    if (!result.isError && result.toolName === "bash") {
      const candidates = result.content.split("\n").filter(line => line.trim().length > 0);
      const summary = candidates.findLast(line => /(?:tests? passed|passing|test suites|build succeeded|successfully)/i.test(line))
        ?? candidates.at(-1);
      if (summary !== undefined && summary.trim() !== "(no output)") {
        lines.push(short(`    ↳ ${summary}`, width));
      }
    }
    if (!result.isError && result.toolName === "edit_file" && call?.arguments !== null &&
        typeof call?.arguments === "object" && !Array.isArray(call.arguments)) {
      const args = call.arguments as Record<string, unknown>;
      if (typeof args.old_text === "string" && typeof args.new_text === "string") {
        const oldLines = args.old_text.split("\n").length;
        const newLines = args.new_text.split("\n").length;
        lines.push(short(`    updated selection · ${oldLines} → ${newLines} lines`, width));
      }
    }
  }
  flushReadGroup();
  return lines;
}

/** Display Shell approvals as bounded, control-safe content instead of raw commands. */
export function approvalPreview(command: string, columns: number): string {
  const width = Math.max(12, columns - 1);
  const visibleLines = terminalText(command).split("\n");
  const truncated = visibleLines.length > 8;
  const lines = [
    "  Shell command · Docker sandbox · network disabled",
    "  ──────────────────────────────────────────",
    ...visibleLines.slice(0, 8).map(line => `  │ ${line}`),
    ...(truncated ? [`  │ … ${visibleLines.length - 8} more lines hidden`] : []),
    "  ──────────────────────────────────────────",
    "  Approve once? [y/N]  ·  Enter deny  ·  Ctrl+C cancel",
  ];
  return `\n${lines.map(line => short(line, width)).join("\n")}\n`;
}

/**
 * Apply theme colors *after* sanitizing untrusted tool text. Keep this outside
 * the pure layout model, so the Painter's line diffing and terminal widths
 * are never based on escape sequences supplied by a tool.
 */
export function colorizeActivity(lines: readonly string[], enabled: boolean): string {
  const safe = lines.map(line => terminalText(line));
  if (!enabled) return safe.join("\n");
  const paint = (line: string): string => {
    const trimmed = line.trimStart();
    const code = trimmed.startsWith("!") ? "31"
      : trimmed.startsWith("✓") || trimmed.startsWith("+") ? "32"
      : trimmed.startsWith("~") ? "36"
      : trimmed.startsWith("-") ? "31"
      : "2";
    return `\u001b[${code}m${line}\u001b[0m`;
  };
  return safe.map(paint).join("\n");
}

/**
 * Review must show the *entire* command. Truncating potentially dangerous
 * suffixes while still offering "y" would make the approval meaningless.
 */
export function commandReviewable(command: string, columns: number): boolean {
  if (command !== terminalText(command)) return false;
  const width = Math.max(12, columns - 1);
  const lines = command.split("\n");
  return lines.length <= 8 &&
    lines.every(line => fitLine(`  │ ${line}`, width) === `  │ ${line}`);
}
