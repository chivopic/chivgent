import { ReadFileTool } from "./read-file.js";
import { ListFilesTool } from "./list-files.js";
import { SearchTextTool } from "./search-text.js";
import type { Tool } from "./tool.js";

/**
 * Keep the concurrency cap small. A model may request dozens of repo-wide
 * searches, so Promise.all(all calls) would otherwise create unbounded work.
 */
export const MAX_PARALLEL_READS = 4;

/**
 * Only exact, built-in read tool implementations may run concurrently.
 * Names and custom metadata are not sufficient evidence that an extension
 * is free of side effects. Subclasses also remain exclusive, since they may
 * override execute() to mutate state.
 */
export function isParallelReadTool(tool: Tool | undefined): boolean {
  return tool !== undefined && (
    tool.constructor === ReadFileTool ||
    tool.constructor === ListFilesTool ||
    tool.constructor === SearchTextTool
  );
}
