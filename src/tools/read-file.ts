import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { WorkspaceError } from "../workspace.js";
import { MAX_TOOL_OUTPUT_BYTES, truncateUtf8 } from "./output.js";

const DEFAULT_START_LINE = 1;
const DEFAULT_LINE_COUNT = 200;
const MAX_LINE_COUNT = 500;
const MAX_CONTENT_BUDGET_BYTES = 48 * 1024;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path relative to the workspace root.",
    },
    start_line: {
      type: "integer",
      minimum: 1,
      description: "First one-based line to read. Usually start with 1.",
    },
    line_count: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LINE_COUNT,
      description: "Number of lines to read. Usually use 200.",
    },
  },
  required: ["path", "start_line", "line_count"],
  additionalProperties: false,
} as const;

interface ReadFileArguments {
  readonly path: string;
  readonly startLine: number;
  readonly lineCount: number;
}

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description =
    "Read a bounded range from a UTF-8 text file inside the workspace. Use list_files or search_text first when the path is unknown.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const argumentsObject = parseArguments(argumentsValue);
    if (argumentsObject === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"path":"relative/file.ts","start_line":1,"line_count":200}; line_count must be from 1 to 500.',
        isError: true,
      };
    }

    try {
      const slice = await context.workspace.readTextFile(argumentsObject.path, {
        startLine: argumentsObject.startLine,
        lineCount: argumentsObject.lineCount,
      });
      return {
        content: formatSlice(
          argumentsObject.path,
          argumentsObject.lineCount,
          slice,
        ),
        isError: false,
      };
    } catch (error: unknown) {
      if (error instanceof WorkspaceError || error instanceof TypeError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}

function parseArguments(value: unknown): ReadFileArguments | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        key !== "path" && key !== "start_line" && key !== "line_count",
    )
  ) {
    return undefined;
  }

  const startLine = record.start_line ?? DEFAULT_START_LINE;
  const lineCount = record.line_count ?? DEFAULT_LINE_COUNT;
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof startLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    typeof lineCount !== "number" ||
    !Number.isSafeInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > MAX_LINE_COUNT
  ) {
    return undefined;
  }

  return { path: record.path, startLine, lineCount };
}

function formatSlice(
  path: string,
  requestedLineCount: number,
  slice: Awaited<ReturnType<ToolContext["workspace"]["readTextFile"]>>,
): string {
  const provisionalHeader = `File: ${path} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})\n---`;
  const provisionalFooter = [
    `[line ${slice.endLine} truncated at the 64 KiB tool-output limit]`,
    `[truncated: continue with ${JSON.stringify({
      path,
      start_line: slice.endLine + 1,
      line_count: requestedLineCount,
    })}]`,
  ].join("\n");
  const contentBudgetBytes = Math.max(
    0,
    Math.min(
      MAX_CONTENT_BUDGET_BYTES,
      MAX_TOOL_OUTPUT_BYTES -
        Buffer.byteLength(provisionalHeader, "utf8") -
        Buffer.byteLength(provisionalFooter, "utf8") -
        2,
    ),
  );
  const segments = splitLinesPreservingEndings(slice.content);
  const accepted: string[] = [];
  let usedBytes = 0;
  let outputTruncated = false;
  let partialLine = false;

  for (const segment of segments) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (usedBytes + segmentBytes <= contentBudgetBytes) {
      accepted.push(segment);
      usedBytes += segmentBytes;
      continue;
    }

    outputTruncated = true;
    if (accepted.length === 0) {
      accepted.push(truncateUtf8(segment, contentBudgetBytes));
      partialLine = true;
    }
    break;
  }

  const consumedLines = accepted.length;
  const actualEndLine =
    slice.totalLines === 0 ? 0 : slice.startLine + consumedLines - 1;
  const header = `File: ${path} (lines ${slice.startLine}-${actualEndLine} of ${slice.totalLines})\n---`;
  const body = accepted.join("");
  const footer: string[] = [];

  if (partialLine) {
    footer.push(
      `[line ${actualEndLine} truncated at the 64 KiB tool-output limit]`,
    );
  }
  if ((slice.truncated || outputTruncated) && actualEndLine < slice.totalLines) {
    footer.push(
      `[truncated: continue with ${JSON.stringify({
        path,
        start_line: actualEndLine + 1,
        line_count: requestedLineCount,
      })}]`,
    );
  }

  let output = `${header}${body.length === 0 ? "" : `\n${body}`}`;
  if (footer.length > 0) {
    if (!output.endsWith("\n")) {
      output += "\n";
    }
    output += footer.join("\n");
  }
  return truncateUtf8(output, MAX_TOOL_OUTPUT_BYTES);
}

function splitLinesPreservingEndings(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }
  const lines = contents.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
