const MAX_TARGET_LENGTH = 80;

/**
 * The one argument worth showing beside a tool call.
 *
 * Full arguments are too much for a status line and for an eval report alike:
 * an edit carries both halves of the change. But a bare tool name cannot tell
 * a read of the right file from a read of the wrong one, so the path — or, for
 * a shell command, its head — is kept and everything else dropped.
 */
export function callTarget(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== "object" || argumentsValue === null) {
    return undefined;
  }
  const record = argumentsValue as Record<string, unknown>;
  const value =
    typeof record.path === "string"
      ? record.path
      : typeof record.command === "string"
        ? record.command
        : undefined;
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value.length > MAX_TARGET_LENGTH
    ? `${value.slice(0, MAX_TARGET_LENGTH)}…`
    : value;
}
