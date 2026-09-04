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
import { readFullTextFileWithBom } from "./read.js";
import { splitLinesPreservingEndings, UTF8_BOM } from "./text.js";

/**
 * A file whose every newline is a CRLF pair can be matched against LF text and
 * converted back afterwards. A file that mixes both styles cannot: rewriting it
 * in one style would touch lines the edit never asked about, so mixed files
 * keep strict byte-for-byte matching instead.
 */
function usesUniformCrlf(contents: string): boolean {
  const carriageReturns = contents.split("\r").length - 1;
  const newlines = contents.split("\n").length - 1;
  const pairs = contents.split("\r\n").length - 1;
  return pairs > 0 && carriageReturns === pairs && newlines === pairs;
}

function toLf(value: string): string {
  return value.split("\r\n").join("\n");
}

function toCrlf(value: string): string {
  return value.split("\n").join("\r\n");
}

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
  if (toLf(oldText) === toLf(newText)) {
    throw new WorkspaceError(
      "invalid_range",
      "old_text and new_text are identical, so the edit would change nothing.",
    );
  }

  // Reading first proves the file exists, is a regular file, is valid UTF-8,
  // and is within the size limit, reusing the read path's guarantees.
  const { contents: original, hadBom } = await readFullTextFileWithBom(
    limits,
    relativePath,
  );
  const resolved = await resolveWritePath(limits.root, relativePath);

  // Models routinely normalise CRLF to LF when they echo text back, so a
  // uniformly-CRLF file is matched in LF and converted back before writing.
  const crlf = usesUniformCrlf(original);
  const haystack = crlf ? toLf(original) : original;
  const needle = crlf ? toLf(oldText) : oldText;
  const replacement = crlf ? toLf(newText) : newText;

  const firstIndex = haystack.indexOf(needle);
  if (firstIndex === -1) {
    throw new WorkspaceError(
      "no_match",
      `old_text does not appear in ${relativePath}. Read the file again and copy the exact text, including indentation.`,
    );
  }
  if (haystack.indexOf(needle, firstIndex + 1) !== -1) {
    throw new WorkspaceError(
      "ambiguous_match",
      `old_text appears more than once in ${relativePath}. Include enough surrounding context to make it unique.`,
    );
  }

  const edited =
    haystack.slice(0, firstIndex) +
    replacement +
    haystack.slice(firstIndex + needle.length);
  // Restore the file's own shape: the edit changed content, not encoding.
  const restored = crlf ? toCrlf(edited) : edited;
  const updated = hadBom ? `${UTF8_BOM}${restored}` : restored;
  const bytesWritten = validateContents(
    updated,
    limits.maxFileBytes,
    relativePath,
  );

  await writeAtomically(resolved.lexicalTarget, updated);

  return {
    path: resolved.relativePath,
    line: splitLinesPreservingEndings(haystack.slice(0, firstIndex)).length + 1,
    bytesWritten,
    totalLines: splitLinesPreservingEndings(restored).length,
  };
}
