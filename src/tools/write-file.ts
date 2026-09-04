import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { WorkspaceError } from "../workspace.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path relative to the workspace root. Missing parent directories are created.",
    },
    contents: {
      type: "string",
      description:
        "The complete new contents of the file. This replaces the whole file, so include every line you want to keep.",
    },
  },
  required: ["path", "contents"],
  additionalProperties: false,
} as const;

interface WriteFileArguments {
  readonly path: string;
  readonly contents: string;
}

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly description =
    "Create a file, or replace an existing file's entire contents, inside the workspace. Prefer edit_file when changing part of a file that already exists.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const argumentsObject = parseArguments(argumentsValue);
    if (argumentsObject === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"path":"relative/file.ts","contents":"..."}.',
        isError: true,
      };
    }

    try {
      const result = await context.workspace.writeTextFile(
        argumentsObject.path,
        argumentsObject.contents,
      );
      return {
        content: `${result.created ? "Created" : "Replaced"} ${result.path} (${result.totalLines} lines, ${result.bytesWritten} bytes).`,
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

function parseArguments(value: unknown): WriteFileArguments | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "path" && key !== "contents")
  ) {
    return undefined;
  }
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.contents !== "string"
  ) {
    return undefined;
  }

  return { path: record.path, contents: record.contents };
}
