import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceError,
  type EditTextFileOptions,
  type EditTextFileResult,
  type WorkspaceLimits,
  type WriteTextFileResult,
} from "./types.js";
import { resolveWritePath } from "./paths.js";
import { readFullTextFile } from "./read.js";
import { splitLinesPreservingEndings } from "./text.js";

/**
 * Writes are staged into a sibling temp file and then renamed over the target.
 * `rename` within one directory is atomic, so a crash midway leaves the
 * original file intact instead of a half-written one.
 */
async function writeAtomically(
  absolutePath: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(absolutePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validateContents(
  contents: string,
  maxFileBytes: number,
  displayPath: string,
): number {
  if (typeof contents !== "string") {
    throw new TypeError("contents must be a string.");
  }
  if (contents.includes("\0")) {
    throw new WorkspaceError(
      "binary_file",
      `Refusing to write NUL bytes: ${displayPath}`,
    );
  }
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > maxFileBytes) {
    throw new WorkspaceError(
      "too_large",
      `Contents exceed the ${maxFileBytes}-byte limit: ${displayPath}`,
    );
  }
  return bytes;
}

export async function writeTextFile(
  limits: WorkspaceLimits,
  relativePath: string,
  contents: string,
): Promise<WriteTextFileResult> {
  const bytesWritten = validateContents(
    contents,
    limits.maxFileBytes,
    relativePath,
  );
  const resolved = await resolveWritePath(limits.root, relativePath);

  await mkdir(path.dirname(resolved.lexicalTarget), { recursive: true });
  await writeAtomically(resolved.lexicalTarget, contents);

  return {
    path: resolved.relativePath,
    created: !resolved.exists,
    bytesWritten,
    totalLines: splitLinesPreservingEndings(contents).length,
  };
}

export async function editTextFile(
  limits: WorkspaceLimits,
  relativePath: string,
  options: EditTextFileOptions,
): Promise<EditTextFileResult> {
  const { oldText, newText } = options;
  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new TypeError("old_text must be a non-empty string.");
  }
  if (typeof newText !== "string") {
    throw new TypeError("new_text must be a string.");
  }
  if (oldText === newText) {
    throw new WorkspaceError(
      "invalid_range",
      "old_text and new_text are identical, so the edit would change nothing.",
    );
  }

  // Reading first proves the file exists, is a regular file, is valid UTF-8,
  // and is within the size limit, reusing the read path's guarantees.
  const original = await readFullTextFile(limits, relativePath);
  const resolved = await resolveWritePath(limits.root, relativePath);

  const firstIndex = original.indexOf(oldText);
  if (firstIndex === -1) {
    throw new WorkspaceError(
      "no_match",
      `old_text does not appear in ${relativePath}. Read the file again and copy the exact text, including indentation.`,
    );
  }
  if (original.indexOf(oldText, firstIndex + 1) !== -1) {
    throw new WorkspaceError(
      "ambiguous_match",
      `old_text appears more than once in ${relativePath}. Include enough surrounding context to make it unique.`,
    );
  }

  const updated =
    original.slice(0, firstIndex) +
    newText +
    original.slice(firstIndex + oldText.length);
  const bytesWritten = validateContents(
    updated,
    limits.maxFileBytes,
    relativePath,
  );

  await writeAtomically(resolved.lexicalTarget, updated);

  return {
    path: resolved.relativePath,
    line: splitLinesPreservingEndings(original.slice(0, firstIndex)).length + 1,
    bytesWritten,
    totalLines: splitLinesPreservingEndings(updated).length,
  };
}
