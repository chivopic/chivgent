import { lstat } from "node:fs/promises";
import { readDirectory } from "./fs.js";
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
  incomplete: boolean;
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
    ...(state.incomplete ? { incomplete: true } : {}),
  };
}

export async function searchText(
  limits: WorkspaceLimits,
  options: SearchTextOptions,
): Promise<SearchTextResult> {
  validateSearchQuery(options.query);
  if (options.exactIdentifier && !isIdentifierQuery(options.query)) {
    throw new TypeError("exact_identifier requires a valid code identifier.");
  }
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
    incomplete: false,
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
      const matchIndex =
        line === undefined
          ? -1
          : options.exactIdentifier
            ? findExactIdentifier(line, options.query)
            : line.indexOf(options.query);
      if (line === undefined || matchIndex < 0) {
        continue;
      }
      if (state.matches.length >= maxResults) {
        state.truncated = true;
        return false;
      }
      state.matches.push({
        path: workspaceRelativeFile,
        line: index + 1,
        preview: createMatchPreview(line, options.query, matchIndex),
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
      directoryEntries = await readDirectory(absoluteDirectory);
    } catch {
      if (absoluteDirectory === start.realTarget) {
        throw new WorkspaceError(
          "discovery_io",
          `The requested directory cannot be enumerated: ${relativePath}. Check directory permissions and retry.`,
        );
      }
      state.incomplete = true;
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

const IDENTIFIER_CONTINUE = /[$_\p{ID_Continue}\u200C\u200D]/u;
const IDENTIFIER_QUERY = /^[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*$/u;

function findExactIdentifier(line: string, identifier: string): number {
  let offset = line.indexOf(identifier);
  while (offset >= 0) {
    // A Unicode code point uses at most two UTF-16 code units.
    const before = [...line.slice(Math.max(0, offset - 2), offset)].at(-1);
    const after = line.codePointAt(offset + identifier.length);
    if (
      (before === undefined || !IDENTIFIER_CONTINUE.test(before)) &&
      (after === undefined || !IDENTIFIER_CONTINUE.test(String.fromCodePoint(after)))
    ) {
      return offset;
    }
    offset = line.indexOf(identifier, offset + 1);
  }
  return -1;
}

export function isIdentifierQuery(identifier: string): boolean {
  return IDENTIFIER_QUERY.test(identifier);
}
