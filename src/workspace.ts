import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SEARCH_BYTES,
  DEFAULT_MAX_SEARCH_FILES,
  WorkspaceError,
  type EditTextFileOptions,
  type EditTextFileResult,
  type ListFilesOptions,
  type ListFilesResult,
  type LocalWorkspaceOptions,
  type ReadTextFileOptions,
  type SearchTextOptions,
  type SearchTextResult,
  type TextFileSlice,
  type Workspace,
  type WorkspaceLimits,
  type WriteTextFileResult,
} from "./workspace/types.js";
import { boundedPositiveInteger } from "./workspace/text.js";
import { readTextFile } from "./workspace/read.js";
import { listFiles } from "./workspace/list.js";
import { searchText } from "./workspace/search.js";
import { editTextFile, writeTextFile } from "./workspace/write.js";
import path from "node:path";

export * from "./workspace/types.js";

/**
 * A workspace rooted at a single directory.
 *
 * Every operation lives in its own module under `src/workspace/` and receives
 * the resolved limits explicitly; this class only owns configuration and the
 * read-only default.
 */
export class LocalWorkspace implements Workspace {
  readonly root: string;
  private readonly limits: WorkspaceLimits;
  private readonly allowWrites: boolean;

  constructor(root: string, options: LocalWorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.allowWrites = options.allowWrites === true;
    this.limits = {
      root: this.root,
      maxFileBytes: boundedPositiveInteger(
        options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        "maxFileBytes",
        DEFAULT_MAX_FILE_BYTES,
      ),
      maxSearchFiles: boundedPositiveInteger(
        options.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES,
        "maxSearchFiles",
        DEFAULT_MAX_SEARCH_FILES,
      ),
      maxSearchBytes: boundedPositiveInteger(
        options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES,
        "maxSearchBytes",
        DEFAULT_MAX_SEARCH_BYTES,
      ),
    };
  }

  /** True when this workspace was constructed with writes enabled. */
  get writable(): boolean {
    return this.allowWrites;
  }

  async readTextFile(
    relativePath: string,
    options: ReadTextFileOptions = {},
  ): Promise<TextFileSlice> {
    return readTextFile(this.limits, relativePath, options);
  }

  async listFiles(options: ListFilesOptions = {}): Promise<ListFilesResult> {
    return listFiles(this.limits, options);
  }

  async searchText(options: SearchTextOptions): Promise<SearchTextResult> {
    return searchText(this.limits, options);
  }

  async writeTextFile(
    relativePath: string,
    contents: string,
  ): Promise<WriteTextFileResult> {
    this.assertWritesEnabled();
    return writeTextFile(this.limits, relativePath, contents);
  }

  async editTextFile(
    relativePath: string,
    options: EditTextFileOptions,
  ): Promise<EditTextFileResult> {
    this.assertWritesEnabled();
    return editTextFile(this.limits, relativePath, options);
  }

  private assertWritesEnabled(): void {
    if (!this.allowWrites) {
      throw new WorkspaceError(
        "writes_disabled",
        "This workspace is read-only. Restart chivgent with --allow-writes to enable file changes.",
      );
    }
  }
}
