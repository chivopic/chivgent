export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export interface BoundedLineOutputOptions {
  readonly emptyMessage: string;
  readonly metadata?: string;
  readonly truncated: boolean;
  readonly truncationMessage: string;
}

export function formatBoundedLineOutput(
  lines: readonly string[],
  options: BoundedLineOutputOptions,
): string {
  const mainLines = lines.length === 0 ? [options.emptyMessage] : lines;
  const reservedSuffix = [options.truncationMessage, options.metadata]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const mainBudget = Math.max(
    0,
    MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(reservedSuffix, "utf8") - 1,
  );
  const accepted: string[] = [];
  let usedBytes = 0;
  let truncated = options.truncated;

  for (const line of mainLines) {
    const separatorBytes = accepted.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (usedBytes + separatorBytes + lineBytes > mainBudget) {
      truncated = true;
      break;
    }
    accepted.push(line);
    usedBytes += separatorBytes + lineBytes;
  }

  const outputLines = [
    ...accepted,
    ...(truncated ? [options.truncationMessage] : []),
    ...(options.metadata === undefined ? [] : [options.metadata]),
  ];
  return truncateUtf8(outputLines.join("\n"), MAX_TOOL_OUTPUT_BYTES);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return value;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Try the previous byte until the UTF-8 prefix is complete.
    }
  }
  return "";
}
