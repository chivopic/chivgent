import { WorkspaceError } from "../workspace.js";
import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { formatBoundedLineOutput } from "./output.js";

const DEFAULT_PATH = ".";
const DEFAULT_MAX_DEPTH = 4;
const MAX_DEPTH = 8;

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        'Directory relative to the workspace root. Use "." for the root.',
    },
    max_depth: {
      type: "integer",
      minimum: 1,
      maximum: MAX_DEPTH,
      description: "Maximum directory depth to include. Usually use 4.",
    },
  },
  required: ["path", "max_depth"],
  additionalProperties: false,
} as const;

interface ListFilesArguments {
  readonly path: string;
  readonly maxDepth: number;
}

export class ListFilesTool implements Tool {
  readonly name = "list_files";
  readonly description =
    "List project files and directories in deterministic order. Ignored, generated, and sensitive paths are excluded.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const argumentsObject = parseArguments(argumentsValue);
    if (argumentsObject === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"path":".","max_depth":4}; max_depth must be an integer from 1 to 8.',
        isError: true,
      };
    }

    try {
      const result = await context.workspace.listFiles({
        path: argumentsObject.path,
        maxDepth: argumentsObject.maxDepth,
      });
      return {
        content: formatBoundedLineOutput(
          result.entries.map((entry) => entry.path),
          {
            emptyMessage: "No discoverable files found.",
            truncated: result.truncated,
            truncationMessage:
              "[truncated: narrow path or reduce max_depth to inspect a smaller subtree]",
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

function parseArguments(value: unknown): ListFilesArguments | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "path" && key !== "max_depth")) {
    return undefined;
  }

  const path = value.path ?? DEFAULT_PATH;
  const maxDepth = value.max_depth ?? DEFAULT_MAX_DEPTH;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof maxDepth !== "number" ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > MAX_DEPTH
  ) {
    return undefined;
  }
  return { path, maxDepth };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
