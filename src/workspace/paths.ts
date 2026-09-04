import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  MAX_RELATIVE_PATH_CHARACTERS,
  WorkspaceError,
} from "./types.js";

export const ALLOWED_ENV_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);
export const FORBIDDEN_DIRECTORY_NAMES = new Set([".git", ".ssh", ".aws"]);
export const FORBIDDEN_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
]);
export const FORBIDDEN_FILE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export interface ResolvedPath {
  readonly lexicalTarget: string;
  readonly realRoot: string;
  readonly realTarget: string;
  readonly relativePath: string;
}

export function isForbiddenRelativePath(relativePath: string): boolean {
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

export function rootRelativeDirectory(relativePath: string): string {
  return relativePath === "." ? "" : relativePath;
}

export function joinWorkspacePath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`;
}

export function toWorkspacePath(relativePath: string): string {
  return relativePath.length === 0
    ? "."
    : relativePath.split(path.sep).join("/");
}

export function compareCodePoints(left: string, right: string): number {
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

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function normalizeRelativePath(
  root: string,
  relativePath: string,
): { readonly lexicalTarget: string; readonly relativePath: string } {
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

  const lexicalTarget = path.resolve(root, relativePath);
  if (!isPathInside(root, lexicalTarget)) {
    throw new WorkspaceError(
      "outside_workspace",
      `Path escapes the workspace: ${relativePath}`,
    );
  }
  const normalizedRelativePath = toWorkspacePath(
    path.relative(root, lexicalTarget),
  );
  if (isForbiddenRelativePath(normalizedRelativePath)) {
    throw new WorkspaceError(
      "forbidden_path",
      "Access to this sensitive workspace path is not allowed.",
    );
  }
  return { lexicalTarget, relativePath: normalizedRelativePath };
}

export async function resolveExistingPath(
  root: string,
  relativePath: string,
): Promise<ResolvedPath> {
  const normalized = normalizeRelativePath(root, relativePath);
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([
      realpath(root),
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

export async function rejectExplicitDirectorySymlink(
  root: string,
  resolved: ResolvedPath,
  requestedPath: string,
): Promise<void> {
  if (resolved.relativePath === ".") {
    return;
  }
  let currentPath = root;
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

export interface ResolvedWritePath {
  readonly lexicalTarget: string;
  readonly realRoot: string;
  readonly relativePath: string;
  /** True when the target itself already exists as a regular file. */
  readonly exists: boolean;
}

/**
 * Resolves a path that may not exist yet.
 *
 * Reads can lean on `realpath` because the target is already there. A write
 * target usually is not, so the boundary is proven against the deepest
 * ancestor that does exist: every existing segment must be a real directory
 * rather than a symlink, and that ancestor must resolve inside the workspace.
 * A symlink planted anywhere along the way is therefore rejected before any
 * bytes are written.
 */
export async function resolveWritePath(
  root: string,
  relativePath: string,
): Promise<ResolvedWritePath> {
  const normalized = normalizeRelativePath(root, relativePath);
  if (normalized.relativePath === ".") {
    throw new WorkspaceError(
      "invalid_path",
      "The workspace root is not a writable file path.",
    );
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    throw new WorkspaceError(
      "not_found",
      `Workspace root does not exist: ${root}`,
      { cause: error },
    );
  }

  const segments = normalized.relativePath.split("/");
  let currentPath = root;
  let exists = false;

  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const isFinalSegment = index === segments.length - 1;

    let segmentStats;
    try {
      segmentStats = await lstat(currentPath);
    } catch {
      // This segment does not exist yet. Nothing below it can exist either,
      // so the remaining segments need no symlink check.
      break;
    }

    if (segmentStats.isSymbolicLink()) {
      throw new WorkspaceError(
        "invalid_path",
        `Symlinks are not followed: ${relativePath}`,
      );
    }
    if (isFinalSegment) {
      if (!segmentStats.isFile()) {
        throw new WorkspaceError(
          "not_a_file",
          `Path is not a regular file: ${relativePath}`,
        );
      }
      exists = true;
    } else if (!segmentStats.isDirectory()) {
      throw new WorkspaceError(
        "not_a_directory",
        `Path is not a directory: ${segments.slice(0, index + 1).join("/")}`,
      );
    }

    const realSegment = await realpath(currentPath);
    if (!isPathInside(realRoot, realSegment)) {
      throw new WorkspaceError(
        "outside_workspace",
        `Path escapes the workspace: ${relativePath}`,
      );
    }
  }

  return {
    lexicalTarget: normalized.lexicalTarget,
    realRoot,
    relativePath: normalized.relativePath,
    exists,
  };
}
