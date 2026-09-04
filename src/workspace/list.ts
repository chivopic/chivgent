import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LIST_DEPTH,
  DEFAULT_LIST_ENTRIES,
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  WorkspaceError,
  type ListFilesOptions,
  type ListFilesResult,
  type WorkspaceEntry,
  type WorkspaceLimits,
} from "./types.js";
import {
  compareCodePoints,
  isForbiddenRelativePath,
  joinWorkspacePath,
  rejectExplicitDirectorySymlink,
  resolveExistingPath,
  rootRelativeDirectory,
} from "./paths.js";
import { createIgnoreMatcher, isDiscoveryIgnored } from "./ignore.js";
import { boundedPositiveInteger } from "./text.js";

export async function listFiles(
  limits: WorkspaceLimits,
  options: ListFilesOptions = {},
): Promise<ListFilesResult> {
  const relativePath = options.path ?? ".";
  const maxDepth = boundedPositiveInteger(
    options.maxDepth ?? DEFAULT_LIST_DEPTH,
    "maxDepth",
    MAX_LIST_DEPTH,
  );
  const maxEntries = boundedPositiveInteger(
    options.maxEntries ?? DEFAULT_LIST_ENTRIES,
    "maxEntries",
    MAX_LIST_ENTRIES,
  );
  const start = await resolveExistingPath(limits.root, relativePath);
  const stats = await lstat(start.realTarget);
  if (!stats.isDirectory()) {
    throw new WorkspaceError(
      "not_a_directory",
      `Path is not a directory: ${relativePath}`,
    );
  }
  await rejectExplicitDirectorySymlink(limits.root, start, relativePath);

  const matcher = await createIgnoreMatcher(limits.root, limits.maxFileBytes);
  if (isDiscoveryIgnored(start.relativePath, true, matcher)) {
    return { entries: [], truncated: false };
  }

  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  const visit = async (
    absoluteDirectory: string,
    workspaceRelativeDirectory: string,
    depth: number,
  ): Promise<boolean> => {
    let directoryEntries;
    try {
      directoryEntries = await readdir(absoluteDirectory, {
        withFileTypes: true,
      });
    } catch {
      return true;
    }
    directoryEntries.sort((left, right) =>
      compareCodePoints(left.name, right.name),
    );

    for (const directoryEntry of directoryEntries) {
      const entryPath = joinWorkspacePath(
        workspaceRelativeDirectory,
        directoryEntry.name,
      );
      const isDirectory = directoryEntry.isDirectory();
      if (
        directoryEntry.isSymbolicLink() ||
        (!isDirectory && !directoryEntry.isFile()) ||
        isForbiddenRelativePath(entryPath) ||
        isDiscoveryIgnored(entryPath, isDirectory, matcher)
      ) {
        continue;
      }

      if (entries.length >= maxEntries) {
        truncated = true;
        return false;
      }
      entries.push({
        path: isDirectory ? `${entryPath}/` : entryPath,
        type: isDirectory ? "directory" : "file",
      });

      if (isDirectory && depth < maxDepth) {
        const shouldContinue = await visit(
          path.join(absoluteDirectory, directoryEntry.name),
          entryPath,
          depth + 1,
        );
        if (!shouldContinue) {
          return false;
        }
      }
    }
    return true;
  };

  await visit(start.realTarget, rootRelativeDirectory(start.relativePath), 1);
  return { entries, truncated };
}
