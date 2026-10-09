import type { Message, ToolCall } from "../messages.js";
import { terminalText, fitLine } from "./text.js";

export const DIFF_PAGE_LINES = 28;

export function mostRecentSuccessfulPatch(messages: readonly Message[]): string | undefined {
  // Each result follows the assistant call that produced it. Walk backwards,
  // searching only the nearest preceding assistant (not unrelated older calls
  // whose IDs a Provider might have reused).
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "tool" || message.toolName !== "apply_patch" || message.isError) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const earlier = messages[j];
      if (earlier?.role === "assistant") {
        const call = earlier.toolCalls.find((tool: ToolCall) =>
          tool.id === message.toolCallId && tool.name === "apply_patch");
        if (call !== undefined && typeof call.arguments === "object" && call.arguments !== null &&
          !Array.isArray(call.arguments)) {
          const patch = (call.arguments as Record<string, unknown>).patch;
          if (typeof patch === "string") return patch;
        }
        break;
      }
      if (earlier?.role === "user") break;
    }
  }
  return undefined;
}

export interface DiffPage {
  readonly text: string;
  readonly page: number;
  readonly pageCount: number;
}

/**
 * Never execute a pager or trust terminal control bytes in a model-provided
 * patch. All pages are bounded and can be navigated with /diff N.
 */
export function formatDiffPage(
  patch: string,
  requestedPage = 1,
  width = 80,
  color = false,
): DiffPage {
  const lines = terminalText(patch).split("\n");
  const pageCount = Math.max(1, Math.ceil(lines.length / DIFF_PAGE_LINES));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(1, Math.min(requestedPage, pageCount))
    : 1;
  const start = (page - 1) * DIFF_PAGE_LINES;
  const bound = Math.max(1, width - 1);
  const chunk = lines.slice(start, start + DIFF_PAGE_LINES).map(line => {
    const safe = fitLine(line, bound);
    if (!color) return safe;
    if (line.startsWith("+")) return `\u001b[32m${safe}\u001b[0m`;
    if (line.startsWith("-")) return `\u001b[31m${safe}\u001b[0m`;
    if (line.startsWith("***")) return `\u001b[36m${safe}\u001b[0m`;
    return safe;
  });
  const title = fitLine(`Last applied patch · page ${page}/${pageCount} · ${lines.length} lines`, bound);
  const next = page < pageCount ? `/diff ${page + 1} for next page` : "End of patch";
  return { text: `${title}\n${chunk.join("\n")}\n${fitLine(next, bound)}\n`, page, pageCount };
}
