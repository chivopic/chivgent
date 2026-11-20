import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

/** Kept behind a workspace-local seam so traversal failures can be tested. */
export function readDirectory(absoluteDirectory: string): Promise<Dirent[]> {
  return readdir(absoluteDirectory, { withFileTypes: true });
}
