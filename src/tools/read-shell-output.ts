import type { ShellOutputStore } from "../shell/output-store.js";
import { validateOutputRead } from "../shell/output-store.js";
import { MAX_OUTPUT_READ_BYTES, MAX_OUTPUT_READ_LINES } from "../shell/output-store.js";
import type { Tool, ToolContext, ToolOutput } from "./tool.js";

export class ReadShellOutputTool implements Tool {
  readonly name = "read_shell_output";
  readonly description = "Read a bounded range of lines from truncated bash output produced in this session. Use the output ID returned by bash; IDs from older or other sessions are unavailable.";
  readonly inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Session-local output ID returned by bash." },
      startLine: { type: "integer", minimum: 1, default: 1 },
      lineCount: { type: "integer", minimum: 1, maximum: MAX_OUTPUT_READ_LINES, default: 50 },
    },
    required: ["id"],
  } as const;

  constructor(private readonly store: ShellOutputStore) {}

  async execute(argumentsValue: unknown, _context: ToolContext): Promise<ToolOutput> {
    const parsed = validateOutputRead(argumentsValue);
    if (parsed === undefined) return { content: "Invalid arguments. Expected a session output ID and a bounded line range.", isError: true };
    const result = await this.store.read(parsed.id, parsed.startLine, parsed.lineCount);
    if (result.state === "unavailable") {
      return { content: "Shell output is unavailable: this ID is expired, belongs to another session, or its file cannot be read.", isError: true };
    }
    if (result.state === "incomplete" && result.content.length === 0) return { content: "Shell output is incomplete: storage limits prevented saving a readable range.", isError: true };
    if (result.linesRead === 0 && result.content.length === 0) {
      return { content: `No lines are available from line ${result.startLine}; output contains ${result.totalLines} lines.`, isError: false };
    }
    const state = result.state === "complete" ? "complete" : "incomplete; saved output reached a storage limit";
    const suffix = result.truncated ? `\n[Read limited to ${MAX_OUTPUT_READ_BYTES} bytes or ${MAX_OUTPUT_READ_LINES} lines; request a later range.]` : "";
    const content = result.content.length === 0 ? "(no lines in this range)" : result.content;
    return { content: `${content}${suffix}\n[Output ${state}; lines ${result.startLine}-${Math.max(result.startLine, result.startLine + result.linesRead - 1)} of ${result.totalLines}]`, isError: false };
  }

}
