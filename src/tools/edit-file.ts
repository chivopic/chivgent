import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { WorkspaceError } from "../workspace.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path relative to the workspace root.",
    },
    old_text: {
      type: "string",
      description:
        "Exact text to replace, copied verbatim from read_file including indentation. It must appear exactly once in the file; add surrounding lines until it is unique.",
    },
    new_text: {
      type: "string",
      description:
        "Text to put in its place. Use an empty string to delete the matched text.",
    },
  },
  required: ["path", "old_text", "new_text"],
  additionalProperties: false,
} as const;

interface EditFileArguments {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Replace one exact, unique passage of text in an existing workspace file. Read the file first so old_text matches byte for byte.";
  readonly inputSchema = inputSchema;

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    const argumentsObject = parseArguments(argumentsValue);
    if (argumentsObject === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"path":"relative/file.ts","old_text":"...","new_text":"..."}; old_text must not be empty.',
        isError: true,
      };
    }

    try {
      const result = await context.workspace.editTextFile(
        argumentsObject.path,
        {
          oldText: argumentsObject.oldText,
          newText: argumentsObject.newText,
        },
      );
      return {
        content: `Edited ${result.path} at line ${result.line} (now ${result.totalLines} lines, ${result.bytesWritten} bytes).`,
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

function parseArguments(value: unknown): EditFileArguments | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "path" && key !== "old_text" && key !== "new_text",
    )
  ) {
    return undefined;
  }
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    typeof record.old_text !== "string" ||
    record.old_text.length === 0 ||
    typeof record.new_text !== "string"
  ) {
    return undefined;
  }

  return {
    path: record.path,
    oldText: record.old_text,
    newText: record.new_text,
  };
}
