import type { TaskResult } from "./runner.js";
import { formatTokens } from "../providers/usage.js";

export interface ReportMeta {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly startedAt: string;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Blank rather than zero when the Provider reported nothing. */
function medianTokens(result: TaskResult): string {
  const totals = result.attempts
    .map((attempt) => attempt.usage?.usage.totalTokens)
    .filter((value): value is number => value !== undefined);
  return totals.length === 0 ? "-" : formatTokens(median(totals));
}

function totalTokens(results: readonly TaskResult[]): number {
  return results.reduce(
    (sum, result) =>
      sum +
      result.attempts.reduce(
        (inner, attempt) => inner + (attempt.usage?.usage.totalTokens ?? 0),
        0,
      ),
    0,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * The table always shows the sample size next to the score.
 *
 * "4/5" and "80%" carry different information from "passed": a rate without its
 * denominator invites reading one lucky attempt as a result.
 */
export function formatTable(results: readonly TaskResult[]): string {
  if (results.length === 0) {
    return "No tasks ran.\n";
  }

  const rows = results.map((result) => ({
    task: result.task,
    pass: `${result.passed}/${result.total}`,
    turns: mean(result.attempts.map((attempt) => attempt.turnCount)).toFixed(1),
    tokens: medianTokens(result),
    tools: [
      ...new Set(result.attempts.flatMap((attempt) => attempt.toolsUsed)),
    ].join(","),
    time: `${(median(result.attempts.map((attempt) => attempt.durationMs)) / 1000).toFixed(1)}s`,
  }));

  const widths = {
    task: Math.max(4, ...rows.map((row) => row.task.length)),
    pass: Math.max(4, ...rows.map((row) => row.pass.length)),
    turns: Math.max(5, ...rows.map((row) => row.turns.length)),
    tokens: Math.max(7, ...rows.map((row) => row.tokens.length)),
    tools: Math.max(5, ...rows.map((row) => row.tools.length)),
  };

  const lines = [
    `${pad("task", widths.task)}  ${pad("pass", widths.pass)}  ${pad("turns", widths.turns)}  ${pad("tok/att", widths.tokens)}  ${pad("tools", widths.tools)}  p50`,
  ];
  for (const row of rows) {
    lines.push(
      `${pad(row.task, widths.task)}  ${pad(row.pass, widths.pass)}  ${pad(row.turns, widths.turns)}  ${pad(row.tokens, widths.tokens)}  ${pad(row.tools, widths.tools)}  ${row.time}`,
    );
  }

  const passed = results.reduce((total, result) => total + result.passed, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const percent = total === 0 ? 0 : Math.round((passed / total) * 100);
  const spent = totalTokens(results);
  lines.push("");
  lines.push(
    `overall  ${passed}/${total} (${percent}%)${spent === 0 ? "" : `  ${formatTokens(spent)} tokens`}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Failures, grouped so the same reason across attempts is one line. */
export function formatFailures(results: readonly TaskResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const byReason = new Map<string, number[]>();
    for (const attempt of result.attempts) {
      for (const failure of attempt.failures) {
        const attempts = byReason.get(failure) ?? [];
        attempts.push(attempt.attempt);
        byReason.set(failure, attempts);
      }
    }
    for (const [reason, attempts] of byReason) {
      lines.push(`${result.task} attempt ${attempts.join(",")}: ${reason}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function toJsonReport(
  results: readonly TaskResult[],
  meta: ReportMeta,
): object {
  return {
    schemaVersion: 1,
    ...meta,
    tasks: results.map((result) => ({
      name: result.task,
      passed: result.passed,
      total: result.total,
      passRate: result.total === 0 ? 0 : result.passed / result.total,
      meanTurns: mean(result.attempts.map((attempt) => attempt.turnCount)),
      totalTokens: result.attempts.reduce(
        (sum, attempt) => sum + (attempt.usage?.usage.totalTokens ?? 0),
        0,
      ),
      medianDurationMs: median(
        result.attempts.map((attempt) => attempt.durationMs),
      ),
      attempts: result.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        passed: attempt.passed,
        status: attempt.status,
        turnCount: attempt.turnCount,
        durationMs: attempt.durationMs,
        toolsUsed: attempt.toolsUsed,
        toolCalls: attempt.toolCalls,
        ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
        failures: attempt.failures,
      })),
    })),
    overall: {
      passed: results.reduce((total, result) => total + result.passed, 0),
      total: results.reduce((sum, result) => sum + result.total, 0),
      totalTokens: totalTokens(results),
    },
  };
}
