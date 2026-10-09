import type { ToolCall, ToolResultMessage } from "../messages.js";
import { parsePatch } from "../patch/parse.js";
import { callTarget } from "../tools/target.js";
import { fitLine, terminalText } from "./text.js";

const MAX_DIFF_LINES = 6;
const MAX_DETAIL_LINE = 120;

function short(value: string, width: number): string {
  return fitLine(terminalText(value), Math.max(1, width));
}

function briefFailure(result: ToolResultMessage): string {
  const line = result.content.split("\n").find(line => line.trim().length > 0) ?? "failed";
  return short(line, 100);
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
    return [short(header, width), ...results.slice(0, MAX_DIFF_LINES).map(line => short(line, width)),
      ...(results.length > MAX_DIFF_LINES ? [short(`    … and ${results.length - MAX_DIFF_LINES} more files`, width)] : [])];
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
