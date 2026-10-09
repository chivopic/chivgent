import { PatchError } from "../patch/parse.js";
import { WorkspaceError } from "../workspace.js";
import type { Tool, ToolContext, ToolOutput } from "./tool.js";

export class ApplyPatchTool implements Tool {
  readonly name = "apply_patch";
  readonly description =
    "Apply a multi-file text patch using *** Begin Patch / *** Add File:, *** Update File:, *** Delete File:, @@, and *** End Patch. " +
    "Update hunks use a leading space for context, - for removed lines and + for added lines. " +
    "Each context must match exactly once; all changes are checked before writing. No Move to, fuzzy matching, or binary patches.";
  readonly inputSchema = {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Complete Codex-style text patch. Use exact lines from read_file; keep enough context to uniquely locate each hunk.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  } as const;

  async execute(input: unknown, context: ToolContext): Promise<ToolOutput> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { content: 'Invalid arguments. Expected {"patch":"*** Begin Patch\\n...\\n*** End Patch"}.', isError: true };
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.patch !== "string") {
      return { content: 'Invalid arguments. Expected {"patch":"*** Begin Patch\\n...\\n*** End Patch"}.', isError: true };
    }
    if (context.workspace.applyPatch === undefined) {
      return { content: "This workspace does not support apply_patch.", isError: true };
    }
    try {
      const result = await context.workspace.applyPatch(record.patch, context.signal);
      const files = [
        ...result.added.map(file => `A ${file}`),
        ...result.updated.map(file => `M ${file}`),
        ...result.deleted.map(file => `D ${file}`),
      ];
      return { content: `Patch applied:\n${files.join("\n")}`, isError: false };
    } catch (error: unknown) {
      if (error instanceof PatchError || error instanceof WorkspaceError || error instanceof TypeError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}
