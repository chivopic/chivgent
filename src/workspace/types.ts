// Shared limits, error types, and the public Workspace contract.

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const DEFAULT_READ_LINE_COUNT = 200;
export const MAX_READ_LINE_COUNT = 500;
export const DEFAULT_LIST_DEPTH = 4;
export const MAX_LIST_DEPTH = 8;
export const DEFAULT_LIST_ENTRIES = 200;
export const MAX_LIST_ENTRIES = 1_000;
export const DEFAULT_SEARCH_RESULTS = 50;
export const MAX_SEARCH_RESULTS = 200;
export const DEFAULT_MAX_SEARCH_FILES = 2_000;
export const DEFAULT_MAX_SEARCH_BYTES = 10 * 1024 * 1024;
export const MAX_QUERY_CHARACTERS = 256;
export const MAX_PREVIEW_CHARACTERS = 300;
export const MAX_RELATIVE_PATH_CHARACTERS = 4_096;

export type WorkspaceErrorCode =
  | "writes_disabled"
  | "no_match"
  | "ambiguous_match"
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

/** Configuration every workspace operation needs, passed explicitly. */
export interface WorkspaceLimits {
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxSearchFiles: number;
  readonly maxSearchBytes: number;
}

export interface WriteTextFileResult {
  readonly path: string;
  /** True when the write created a file that did not exist before. */
  readonly created: boolean;
  readonly bytesWritten: number;
  readonly totalLines: number;
}

export interface EditTextFileOptions {
  readonly oldText: string;
  readonly newText: string;
}

export interface EditTextFileResult {
  readonly path: string;
  /** One-based line where the replaced text began. */
  readonly line: number;
  readonly bytesWritten: number;
  readonly totalLines: number;
}

export interface Workspace {
  readonly root: string;
  readTextFile(
    relativePath: string,
    options?: ReadTextFileOptions,
  ): Promise<TextFileSlice>;
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;
  searchText(options: SearchTextOptions): Promise<SearchTextResult>;
  /** Rejects unless the workspace was constructed with writes enabled. */
  writeTextFile(
    relativePath: string,
    contents: string,
  ): Promise<WriteTextFileResult>;
  /** Rejects unless the workspace was constructed with writes enabled. */
  editTextFile(
    relativePath: string,
    options: EditTextFileOptions,
  ): Promise<EditTextFileResult>;
}

export interface LocalWorkspaceOptions {
  /** Writes are refused unless this is explicitly true. */
  readonly allowWrites?: boolean;
  readonly maxFileBytes?: number;
  readonly maxSearchFiles?: number;
  readonly maxSearchBytes?: number;
}

export function invalidRange(
  relativePath: string,
  startLine: number,
  totalLines: number,
): WorkspaceError {
  return new WorkspaceError(
    "invalid_range",
    `start_line ${startLine} is outside ${relativePath}, which has ${totalLines} lines.`,
  );
}
