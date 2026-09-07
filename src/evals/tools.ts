import type { Tool } from "../tools/tool.js";
import { ListFilesTool } from "../tools/list-files.js";
import { ReadFileTool } from "../tools/read-file.js";
import { SearchTextTool } from "../tools/search-text.js";
import { WriteFileTool } from "../tools/write-file.js";
import { EditFileTool } from "../tools/edit-file.js";
import { BashTool } from "../tools/bash.js";
import type { Capability } from "./task.js";

/**
 * What each capability puts in the model's hands.
 *
 * This lives apart from the runner because task loading needs the same answer:
 * a grader that names a tool the task never grants is either an assertion that
 * cannot fail or one that cannot pass, and both are worth refusing before the
 * run starts. Keeping one list means the two cannot drift.
 */
const ALWAYS = ["list_files", "search_text", "read_file"] as const;
const BY_CAPABILITY: Record<Capability, readonly string[]> = {
  writes: ["write_file", "edit_file"],
  shell: ["bash"],
};

export function toolNamesFor(
  capabilities: readonly Capability[],
): readonly string[] {
  return [
    ...ALWAYS,
    ...capabilities.flatMap((capability) => BY_CAPABILITY[capability]),
  ];
}

export function toolsFor(
  capabilities: readonly Capability[],
  cwd: string,
): readonly Tool[] {
  const tools: Tool[] = [
    new ListFilesTool(),
    new SearchTextTool(),
    new ReadFileTool(),
  ];
  if (capabilities.includes("writes")) {
    tools.push(new WriteFileTool(), new EditFileTool());
  }
  if (capabilities.includes("shell")) {
    tools.push(new BashTool({ cwd }));
  }
  return tools;
}
