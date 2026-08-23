import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

export type WorkspaceErrorCode =
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "not_a_file"
  | "too_large"
  | "binary_file"
  | "invalid_utf8";

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

export interface Workspace {
  readonly root: string;
  readTextFile(relativePath: string): Promise<string>;
}

export interface LocalWorkspaceOptions {
  readonly maxFileBytes?: number;
}

export class LocalWorkspace implements Workspace {
  readonly root: string;
  private readonly maxFileBytes: number;

  constructor(root: string, options: LocalWorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes <= 0) {
      throw new TypeError("maxFileBytes must be a positive safe integer.");
    }
  }

  async readTextFile(relativePath: string): Promise<string> {
    this.validateRelativePath(relativePath);

    const lexicalTarget = path.resolve(this.root, relativePath);
    if (!isPathInside(this.root, lexicalTarget)) {
      throw new WorkspaceError(
        "outside_workspace",
        `Path escapes the workspace: ${relativePath}`,
      );
    }

    let realRoot: string;
    let realTarget: string;
    try {
      [realRoot, realTarget] = await Promise.all([
        realpath(this.root),
        realpath(lexicalTarget),
      ]);
    } catch (error) {
      throw new WorkspaceError(
        "not_found",
        `File does not exist: ${relativePath}`,
        { cause: error },
      );
    }

    if (!isPathInside(realRoot, realTarget)) {
      throw new WorkspaceError(
        "outside_workspace",
        `Path escapes the workspace: ${relativePath}`,
      );
    }

    const stats = await lstat(realTarget);
    if (!stats.isFile()) {
      throw new WorkspaceError(
        "not_a_file",
        `Path is not a regular file: ${relativePath}`,
      );
    }
    if (stats.size > this.maxFileBytes) {
      throw new WorkspaceError(
        "too_large",
        `File exceeds the ${this.maxFileBytes}-byte limit: ${relativePath}`,
      );
    }

    const contents = await readFile(realTarget);
    if (contents.byteLength > this.maxFileBytes) {
      throw new WorkspaceError(
        "too_large",
        `File exceeds the ${this.maxFileBytes}-byte limit: ${relativePath}`,
      );
    }
    if (contents.includes(0)) {
      throw new WorkspaceError(
        "binary_file",
        `File appears to be binary: ${relativePath}`,
      );
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch (error) {
      throw new WorkspaceError(
        "invalid_utf8",
        `File is not valid UTF-8: ${relativePath}`,
        { cause: error },
      );
    }
  }

  private validateRelativePath(relativePath: string): void {
    if (
      relativePath.length === 0 ||
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath)
    ) {
      throw new WorkspaceError(
        "invalid_path",
        "read_file requires a non-empty path relative to the workspace.",
      );
    }
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
