import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import createIgnore, { type Ignore } from "ignore";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_READ_LINE_COUNT = 200;
const MAX_READ_LINE_COUNT = 500;
const DEFAULT_LIST_DEPTH = 4;
const MAX_LIST_DEPTH = 8;
const DEFAULT_LIST_ENTRIES = 200;
const MAX_LIST_ENTRIES = 1_000;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const DEFAULT_MAX_SEARCH_FILES = 2_000;
const DEFAULT_MAX_SEARCH_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_CHARACTERS = 256;
const MAX_PREVIEW_CHARACTERS = 300;
const MAX_RELATIVE_PATH_CHARACTERS = 4_096;

const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".cache/",
] as const;

const ALLOWED_ENV_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);
const FORBIDDEN_DIRECTORY_NAMES = new Set([".git", ".ssh", ".aws"]);
const FORBIDDEN_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
]);
const FORBIDDEN_FILE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export type WorkspaceErrorCode =
  | "invalid_path"
  | "outside_workspace"
  | "forbidden_path"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "binary_file"
  | "invalid_utf8"
  | "invalid_range";

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export interface ReadTextFileOptions {
  readonly startLine?: number;
  readonly lineCount?: number;
}

export interface TextFileSlice {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface ListFilesOptions {
  readonly path?: string;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

export interface ListFilesResult {
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
}

export interface SearchTextOptions {
  readonly query: string;
  readonly path?: string;
  readonly maxResults?: number;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export interface SearchTextResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
  readonly scannedFiles: number;
  readonly skippedFiles: number;
}

export interface Workspace {
  readonly root: string;
  readTextFile(
    relativePath: string,
    options?: ReadTextFileOptions,
  ): Promise<TextFileSlice>;
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;
  searchText(options: SearchTextOptions): Promise<SearchTextResult>;
}

export interface LocalWorkspaceOptions {
  readonly maxFileBytes?: number;
  readonly maxSearchFiles?: number;
  readonly maxSearchBytes?: number;
}

interface ResolvedPath {
  readonly lexicalTarget: string;
  readonly realRoot: string;
  readonly realTarget: string;
  readonly relativePath: string;
}

interface SearchState {
  readonly matches: SearchMatch[];
  scannedFiles: number;
  skippedFiles: number;
  examinedFiles: number;
  scannedBytes: number;
  truncated: boolean;
}

export class LocalWorkspace implements Workspace {
  readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxSearchFiles: number;
  private readonly maxSearchBytes: number;

  constructor(root: string, options: LocalWorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.maxFileBytes = boundedPositiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
      DEFAULT_MAX_FILE_BYTES,
    );
    this.maxSearchFiles = boundedPositiveInteger(
      options.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES,
      "maxSearchFiles",
      DEFAULT_MAX_SEARCH_FILES,
    );
    this.maxSearchBytes = boundedPositiveInteger(
      options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES,
      "maxSearchBytes",
      DEFAULT_MAX_SEARCH_BYTES,
    );
  }

  async readTextFile(
    relativePath: string,
    options: ReadTextFileOptions = {},
  ): Promise<TextFileSlice> {
    const startLine = boundedPositiveInteger(
      options.startLine ?? 1,
      "startLine",
      Number.MAX_SAFE_INTEGER,
    );
    const lineCount = boundedPositiveInteger(
      options.lineCount ?? DEFAULT_READ_LINE_COUNT,
      "lineCount",
      MAX_READ_LINE_COUNT,
    );
    const contents = await this.readFullTextFile(relativePath);
    const lines = splitLinesPreservingEndings(contents);

    if (lines.length === 0) {
      if (startLine !== 1) {
        throw invalidRange(relativePath, startLine, 0);
      }
      return {
        content: "",
        startLine: 1,
        endLine: 0,
        totalLines: 0,
        truncated: false,
      };
    }

    if (startLine > lines.length) {
      throw invalidRange(relativePath, startLine, lines.length);
    }

    const endLine = Math.min(lines.length, startLine + lineCount - 1);
    return {
      content: lines.slice(startLine - 1, endLine).join(""),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
    };
  }

  async listFiles(
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
    const start = await this.resolveExistingPath(relativePath);
    const stats = await lstat(start.realTarget);
    if (!stats.isDirectory()) {
      throw new WorkspaceError(
        "not_a_directory",
        `Path is not a directory: ${relativePath}`,
      );
    }
    await this.rejectExplicitDirectorySymlink(start, relativePath);

    const matcher = await this.createIgnoreMatcher();
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

  async searchText(options: SearchTextOptions): Promise<SearchTextResult> {
    validateSearchQuery(options.query);
    const relativePath = options.path ?? ".";
    const maxResults = boundedPositiveInteger(
      options.maxResults ?? DEFAULT_SEARCH_RESULTS,
      "maxResults",
      MAX_SEARCH_RESULTS,
    );
    const start = await this.resolveExistingPath(relativePath);
    const stats = await lstat(start.realTarget);
    const matcher = await this.createIgnoreMatcher();
    const startIsDirectory = stats.isDirectory();

    if (!startIsDirectory && !stats.isFile()) {
      throw new WorkspaceError(
        "not_a_file",
        `Path is not a regular file or directory: ${relativePath}`,
      );
    }
    if (startIsDirectory) {
      await this.rejectExplicitDirectorySymlink(start, relativePath);
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
      if (state.examinedFiles >= this.maxSearchFiles) {
        state.truncated = true;
        return false;
      }
      state.examinedFiles += 1;

      let resolved: ResolvedPath;
      let fileStats;
      try {
        resolved = await this.resolveExistingPath(workspaceRelativeFile);
        fileStats = await lstat(resolved.realTarget);
      } catch {
        state.skippedFiles += 1;
        return true;
      }

      if (!fileStats.isFile() || fileStats.size > this.maxFileBytes) {
        state.skippedFiles += 1;
        return true;
      }
      if (state.scannedBytes + fileStats.size > this.maxSearchBytes) {
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
          this.maxFileBytes,
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

  private async readFullTextFile(relativePath: string): Promise<string> {
    const resolved = await this.resolveExistingPath(relativePath);
    return readUtf8File(
      resolved.realTarget,
      relativePath,
      this.maxFileBytes,
    );
  }

  private async resolveExistingPath(relativePath: string): Promise<ResolvedPath> {
    const normalized = this.normalizeRelativePath(relativePath);
    let realRoot: string;
    let realTarget: string;
    try {
      [realRoot, realTarget] = await Promise.all([
        realpath(this.root),
        realpath(normalized.lexicalTarget),
      ]);
    } catch (error) {
      throw new WorkspaceError(
        "not_found",
        `Path does not exist: ${relativePath}`,
        { cause: error },
      );
    }

    if (!isPathInside(realRoot, realTarget)) {
      throw new WorkspaceError(
        "outside_workspace",
        `Path escapes the workspace: ${relativePath}`,
      );
    }
    return {
      lexicalTarget: normalized.lexicalTarget,
      realRoot,
      realTarget,
      relativePath: normalized.relativePath,
    };
  }

  private normalizeRelativePath(relativePath: string): {
    readonly lexicalTarget: string;
    readonly relativePath: string;
  } {
    if (
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      relativePath.length > MAX_RELATIVE_PATH_CHARACTERS ||
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath)
    ) {
      throw new WorkspaceError(
        "invalid_path",
        "Workspace tools require a non-empty path relative to the workspace.",
      );
    }

    const lexicalTarget = path.resolve(this.root, relativePath);
    if (!isPathInside(this.root, lexicalTarget)) {
      throw new WorkspaceError(
        "outside_workspace",
        `Path escapes the workspace: ${relativePath}`,
      );
    }
    const normalizedRelativePath = toWorkspacePath(
      path.relative(this.root, lexicalTarget),
    );
    if (isForbiddenRelativePath(normalizedRelativePath)) {
      throw new WorkspaceError(
        "forbidden_path",
        "Access to this sensitive workspace path is not allowed.",
      );
    }
    return {
      lexicalTarget,
      relativePath: normalizedRelativePath,
    };
  }

  private async rejectExplicitDirectorySymlink(
    resolved: ResolvedPath,
    requestedPath: string,
  ): Promise<void> {
    if (resolved.relativePath === ".") {
      return;
    }
    let currentPath = this.root;
    for (const segment of resolved.relativePath.split("/")) {
      currentPath = path.join(currentPath, segment);
      let lexicalStats;
      try {
        lexicalStats = await lstat(currentPath);
      } catch (error) {
        throw new WorkspaceError(
          "not_found",
          `Path does not exist: ${requestedPath}`,
          { cause: error },
        );
      }
      if (lexicalStats.isSymbolicLink()) {
        throw new WorkspaceError(
          "invalid_path",
          `Directory symlinks are not followed: ${requestedPath}`,
        );
      }
    }
  }

  private async createIgnoreMatcher(): Promise<Ignore> {
    const matcher = createIgnore();
    const ignorePath = path.join(this.root, ".gitignore");
    try {
      const stats = await lstat(ignorePath);
      if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.size <= this.maxFileBytes
      ) {
        matcher.add(await readFile(ignorePath, "utf8"));
      }
    } catch {
      // A missing or unreadable root .gitignore does not prevent discovery.
    }
    return matcher.add(DEFAULT_IGNORE_PATTERNS);
  }
}

async function readUtf8File(
  absolutePath: string,
  displayPath: string,
  maxFileBytes: number,
): Promise<string> {
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    throw new WorkspaceError(
      "not_a_file",
      `Path is not a regular file: ${displayPath}`,
    );
  }
  if (stats.size > maxFileBytes) {
    throw new WorkspaceError(
      "too_large",
      `File exceeds the ${maxFileBytes}-byte limit: ${displayPath}`,
    );
  }

  const contents = await readFile(absolutePath);
  if (contents.byteLength > maxFileBytes) {
    throw new WorkspaceError(
      "too_large",
      `File exceeds the ${maxFileBytes}-byte limit: ${displayPath}`,
    );
  }
  if (contents.includes(0)) {
    throw new WorkspaceError(
      "binary_file",
      `File appears to be binary: ${displayPath}`,
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new WorkspaceError(
      "invalid_utf8",
      `File is not valid UTF-8: ${displayPath}`,
      { cause: error },
    );
  }
}

function validateSearchQuery(query: string): void {
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    [...query].length > MAX_QUERY_CHARACTERS ||
    query.includes("\0") ||
    query.includes("\r") ||
    query.includes("\n")
  ) {
    throw new TypeError(
      "query must contain 1 to 256 characters without NUL or line breaks.",
    );
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  const validated = positiveSafeInteger(value, name);
  if (validated > maximum) {
    throw new TypeError(`${name} must be at most ${maximum}.`);
  }
  return validated;
}

function invalidRange(
  relativePath: string,
  startLine: number,
  totalLines: number,
): WorkspaceError {
  return new WorkspaceError(
    "invalid_range",
    `start_line ${startLine} is outside ${relativePath}, which has ${totalLines} lines.`,
  );
}

function splitLinesPreservingEndings(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }
  const lines = contents.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function splitLines(contents: string): string[] {
  return splitLinesPreservingEndings(contents).map((line) =>
    line.replace(/(?:\r\n|\r|\n)$/, ""),
  );
}

function createMatchPreview(line: string, query: string): string {
  const characters = [...line];
  if (characters.length <= MAX_PREVIEW_CHARACTERS) {
    return line;
  }

  const matchIndex = line.indexOf(query);
  const prefixCharacters = [...line.slice(0, matchIndex)].length;
  const queryCharacters = [...query].length;
  const initialContext = Math.max(
    0,
    MAX_PREVIEW_CHARACTERS - queryCharacters - 2,
  );
  let start = Math.max(
    0,
    prefixCharacters - Math.floor(initialContext / 2),
  );
  let hasPrefix = start > 0;
  let hasSuffix = true;
  let contentBudget =
    MAX_PREVIEW_CHARACTERS - Number(hasPrefix) - Number(hasSuffix);
  let end = Math.min(characters.length, start + contentBudget);
  hasSuffix = end < characters.length;
  contentBudget =
    MAX_PREVIEW_CHARACTERS - Number(hasPrefix) - Number(hasSuffix);
  end = Math.min(characters.length, start + contentBudget);
  if (end === characters.length) {
    start = Math.max(
      0,
      end - (MAX_PREVIEW_CHARACTERS - Number(start > 0)),
    );
    hasPrefix = start > 0;
  }

  return `${hasPrefix ? "…" : ""}${characters
    .slice(start, end)
    .join("")}${end < characters.length ? "…" : ""}`;
}

function isForbiddenRelativePath(relativePath: string): boolean {
  if (relativePath === ".") {
    return false;
  }
  const segments = relativePath
    .split("/")
    .filter((segment) => segment.length > 0);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (
    lowerSegments.some((segment) => FORBIDDEN_DIRECTORY_NAMES.has(segment))
  ) {
    return true;
  }

  const basename = lowerSegments.at(-1);
  if (basename === undefined) {
    return false;
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return !ALLOWED_ENV_FILES.has(basename);
  }
  return (
    FORBIDDEN_FILE_NAMES.has(basename) ||
    FORBIDDEN_FILE_EXTENSIONS.has(path.posix.extname(basename))
  );
}

function isDiscoveryIgnored(
  relativePath: string,
  isDirectory: boolean,
  matcher: Ignore,
): boolean {
  if (relativePath === ".") {
    return false;
  }
  return matcher.ignores(isDirectory ? `${relativePath}/` : relativePath);
}

function rootRelativeDirectory(relativePath: string): string {
  return relativePath === "." ? "" : relativePath;
}

function joinWorkspacePath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`;
}

function toWorkspacePath(relativePath: string): string {
  return relativePath.length === 0
    ? "."
    : relativePath.split(path.sep).join("/");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0) ?? 0);
  const rightPoints = [...right].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function emptySearchResult(): SearchTextResult {
  return {
    matches: [],
    truncated: false,
    scannedFiles: 0,
    skippedFiles: 0,
  };
}

function searchResult(state: SearchState): SearchTextResult {
  return {
    matches: state.matches,
    truncated: state.truncated,
    scannedFiles: state.scannedFiles,
    skippedFiles: state.skippedFiles,
  };
}
