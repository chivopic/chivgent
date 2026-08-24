import { WorkspaceError } from "../workspace.js";
import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { formatBoundedLineOutput } from "./output.js";

const DEFAULT_PATH = ".";
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_QUERY_CHARACTERS = 256;

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Case-sensitive literal text to find, from 1 to 256 characters without line breaks. Regular expressions are not supported.",
    },
    path: {
      type: "string",
      description:
        'File or directory relative to the workspace root. Use "." for the root.',
    },
    max_results: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULTS,
      description: "Maximum matches to return. Usually use 50.",
    },
  },
  required: ["query", "path", "max_results"],
  additionalProperties: false,
} as const;

interface SearchTextArguments {
  readonly query: string;
  readonly path: string;
  readonly maxResults: number;
}

export class SearchTextTool implements Tool {
  readonly name = "search_text";
  readonly description =
    "Search discoverable UTF-8 project files for case-sensitive literal text and return file paths, line numbers, and previews.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const argumentsObject = parseArguments(argumentsValue);
    if (argumentsObject === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"query":"literal text","path":".","max_results":50}; query must be one line and max_results must be from 1 to 200.',
        isError: true,
      };
    }

    try {
      const result = await context.workspace.searchText({
        query: argumentsObject.query,
        path: argumentsObject.path,
        maxResults: argumentsObject.maxResults,
      });
      return {
        content: formatBoundedLineOutput(
          result.matches.map(
            (match) => `${match.path}:${match.line}:${match.preview}`,
          ),
          {
            emptyMessage: "No matches found.",
            metadata: `[scanned: ${result.scannedFiles} files; skipped: ${result.skippedFiles}]`,
            truncated: result.truncated,
            truncationMessage:
              "[truncated: narrow path or use a more specific query]",
          },
        ),
        isError: false,
      };
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof TypeError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}

function parseArguments(value: unknown): SearchTextArguments | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => key !== "query" && key !== "path" && key !== "max_results",
    )
  ) {
    return undefined;
  }

  const query = value.query;
  const path = value.path ?? DEFAULT_PATH;
  const maxResults = value.max_results ?? DEFAULT_MAX_RESULTS;
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    [...query].length > MAX_QUERY_CHARACTERS ||
    query.includes("\0") ||
    query.includes("\r") ||
    query.includes("\n") ||
    typeof path !== "string" ||
    path.length === 0 ||
    typeof maxResults !== "number" ||
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > MAX_RESULTS
  ) {
    return undefined;
  }
  return { query, path, maxResults };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
