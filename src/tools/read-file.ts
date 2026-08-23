import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { WorkspaceError } from "../workspace.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path relative to the workspace root.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file inside the current workspace. Use a relative path.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const pathValue = parsePathArgument(argumentsValue);
    if (pathValue === undefined) {
      return {
        content:
          'Invalid arguments. Expected exactly one non-empty string field: {"path":"relative/file.ts"}.',
        isError: true,
      };
    }

    try {
      return {
        content: await context.workspace.readTextFile(pathValue),
        isError: false,
      };
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}

function parsePathArgument(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.path !== "string" ||
    record.path.length === 0
  ) {
    return undefined;
  }

  return record.path;
}
