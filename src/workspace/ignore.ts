import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import createIgnore, { type Ignore } from "ignore";

export type { Ignore };

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".cache/",
] as const;

export function isDiscoveryIgnored(
  relativePath: string,
  isDirectory: boolean,
  matcher: Ignore,
): boolean {
  if (relativePath === ".") {
    return false;
  }
  return matcher.ignores(isDirectory ? `${relativePath}/` : relativePath);
}

export async function createIgnoreMatcher(
  root: string,
  maxFileBytes: number,
): Promise<Ignore> {
  const matcher = createIgnore();
  const ignorePath = path.join(root, ".gitignore");
  try {
    const stats = await lstat(ignorePath);
    if (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.size <= maxFileBytes
    ) {
      matcher.add(await readFile(ignorePath, "utf8"));
    }
  } catch {
    // A missing or unreadable root .gitignore does not prevent discovery.
  }
  return matcher.add(DEFAULT_IGNORE_PATTERNS);
}
