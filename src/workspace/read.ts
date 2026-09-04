import {
  DEFAULT_READ_LINE_COUNT,
  MAX_READ_LINE_COUNT,
  invalidRange,
  type ReadTextFileOptions,
  type TextFileSlice,
  type WorkspaceLimits,
} from "./types.js";
import { resolveExistingPath } from "./paths.js";
import {
  boundedPositiveInteger,
  readUtf8File,
  splitLinesPreservingEndings,
} from "./text.js";

export async function readFullTextFile(
  limits: WorkspaceLimits,
  relativePath: string,
): Promise<string> {
  const resolved = await resolveExistingPath(limits.root, relativePath);
  return readUtf8File(resolved.realTarget, relativePath, limits.maxFileBytes);
}

export async function readTextFile(
  limits: WorkspaceLimits,
  relativePath: string,
  options: ReadTextFileOptions = {},
): Promise<TextFileSlice> {
  const startLine = boundedPositiveInteger(
    options.startLine ?? 1,
    "startLine",
    Number.MAX_SAFE_INTEGER,
  );
  const lineCount = boundedPositiveInteger(
    options.lineCount ?? DEFAULT_READ_LINE_COUNT,
    "lineCount",
    MAX_READ_LINE_COUNT,
  );
  const contents = await readFullTextFile(limits, relativePath);
  const lines = splitLinesPreservingEndings(contents);

  if (lines.length === 0) {
    if (startLine !== 1) {
      throw invalidRange(relativePath, startLine, 0);
    }
    return {
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    };
  }

  if (startLine > lines.length) {
    throw invalidRange(relativePath, startLine, lines.length);
  }

  const endLine = Math.min(lines.length, startLine + lineCount - 1);
  return {
    content: lines.slice(startLine - 1, endLine).join(""),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated: endLine < lines.length,
  };
}
