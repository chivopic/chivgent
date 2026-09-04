import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  WorkspaceError,
  type SearchMatch,
  type SearchTextOptions,
  type SearchTextResult,
  type WorkspaceLimits,
} from "./types.js";
import {
  compareCodePoints,
  isForbiddenRelativePath,
  joinWorkspacePath,
  rejectExplicitDirectorySymlink,
  resolveExistingPath,
  rootRelativeDirectory,
  type ResolvedPath,
} from "./paths.js";
import { createIgnoreMatcher, isDiscoveryIgnored } from "./ignore.js";
import {
  boundedPositiveInteger,
  createMatchPreview,
  readUtf8File,
  splitLines,
  validateSearchQuery,
} from "./text.js";

interface SearchState {
  readonly matches: SearchMatch[];
  scannedFiles: number;
  skippedFiles: number;
  examinedFiles: number;
  scannedBytes: number;
  truncated: boolean;
}

function emptySearchResult(): SearchTextResult {
  return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
}

function searchResult(state: SearchState): SearchTextResult {
  return {
    matches: state.matches,
    truncated: state.truncated,
    scannedFiles: state.scannedFiles,
    skippedFiles: state.skippedFiles,
  };
}

export async function searchText(
  limits: WorkspaceLimits,
  options: SearchTextOptions,
): Promise<SearchTextResult> {
  validateSearchQuery(options.query);
  const relativePath = options.path ?? ".";
  const maxResults = boundedPositiveInteger(
    options.maxResults ?? DEFAULT_SEARCH_RESULTS,
    "maxResults",
    MAX_SEARCH_RESULTS,
  );
  const start = await resolveExistingPath(limits.root, relativePath);
  const stats = await lstat(start.realTarget);
  const matcher = await createIgnoreMatcher(limits.root, limits.maxFileBytes);
  const startIsDirectory = stats.isDirectory();

  if (!startIsDirectory && !stats.isFile()) {
    throw new WorkspaceError(
      "not_a_file",
      `Path is not a regular file or directory: ${relativePath}`,
    );
  }
  if (startIsDirectory) {
    await rejectExplicitDirectorySymlink(limits.root, start, relativePath);
  }
  if (isDiscoveryIgnored(start.relativePath, startIsDirectory, matcher)) {
    return emptySearchResult();
  }

  const state: SearchState = {
    matches: [],
    scannedFiles: 0,
    skippedFiles: 0,
    examinedFiles: 0,
    scannedBytes: 0,
    truncated: false,
  };

  const scanFile = async (
    absoluteFile: string,
    workspaceRelativeFile: string,
  ): Promise<boolean> => {
    if (state.examinedFiles >= limits.maxSearchFiles) {
      state.truncated = true;
      return false;
    }
    state.examinedFiles += 1;

    let resolved: ResolvedPath;
    let fileStats;
    try {
      resolved = await resolveExistingPath(limits.root, workspaceRelativeFile);
      fileStats = await lstat(resolved.realTarget);
    } catch {
      state.skippedFiles += 1;
      return true;
    }

    if (!fileStats.isFile() || fileStats.size > limits.maxFileBytes) {
      state.skippedFiles += 1;
      return true;
    }
    if (state.scannedBytes + fileStats.size > limits.maxSearchBytes) {
      state.truncated = true;
      return false;
    }

    let contents: string;
    try {
      contents = await readUtf8File(
        absoluteFile === resolved.realTarget
          ? absoluteFile
          : resolved.realTarget,
        workspaceRelativeFile,
        limits.maxFileBytes,
      );
    } catch {
      state.skippedFiles += 1;
      return true;
    }

    state.scannedBytes += Buffer.byteLength(contents, "utf8");
    state.scannedFiles += 1;
    const lines = splitLines(contents);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || !line.includes(options.query)) {
        continue;
      }
      if (state.matches.length >= maxResults) {
        state.truncated = true;
        return false;
      }
      state.matches.push({
        path: workspaceRelativeFile,
        line: index + 1,
        preview: createMatchPreview(line, options.query),
      });
    }
    return true;
  };

  if (stats.isFile()) {
    await scanFile(start.realTarget, start.relativePath);
    return searchResult(state);
  }

  const visit = async (
    absoluteDirectory: string,
    workspaceRelativeDirectory: string,
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

      const absoluteEntry = path.join(
        absoluteDirectory,
        directoryEntry.name,
      );
      const shouldContinue = isDirectory
        ? await visit(absoluteEntry, entryPath)
        : await scanFile(absoluteEntry, entryPath);
      if (!shouldContinue) {
        return false;
      }
    }
    return true;
  };

  await visit(start.realTarget, rootRelativeDirectory(start.relativePath));
  return searchResult(state);
}
