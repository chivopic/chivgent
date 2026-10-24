import { isForbiddenRelativePath } from "../../../src/workspace/paths.js";

/** Additional Desktop review exclusions for agent and app metadata directories. */
export function isForbiddenDesktopReviewPath(relativePath: string): boolean {
  return isForbiddenRelativePath(relativePath) || relativePath.split(/[\\/]/).some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === ".agents" || normalized === ".codex";
  });
}
