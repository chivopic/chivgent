import { PatchError, parsePatch } from "../patch/parse.js";
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
      const summary = parsePatch(record.patch).map(change => {
        if (change.kind === "add") return `A ${change.path} (+${change.lines.length})`;
        if (change.kind === "delete") return `D ${change.path}`;
        const plus = change.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
        const minus = change.hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
        return `M ${change.path} (+${plus}/-${minus}, ${change.hunks.length} hunk(s))`;
      });
      // The engine returns canonical file paths; the summary follows the
      // validated patch's original file ordering for readable diff feedback.
      return { content: `Patch applied (${result.added.length + result.updated.length + result.deleted.length} files):\n${summary.join("\n")}`, isError: false };
    } catch (error: unknown) {
      if (error instanceof PatchError || error instanceof WorkspaceError || error instanceof TypeError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }
  }
}
