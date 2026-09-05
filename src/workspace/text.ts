import { lstat, readFile } from "node:fs/promises";
import { MAX_PREVIEW_CHARACTERS, MAX_QUERY_CHARACTERS, WorkspaceError } from "./types.js";

export const UTF8_BOM = "\uFEFF";

export interface Utf8FileContents {
  readonly contents: string;
  /** True when the file began with a UTF-8 byte order mark. */
  readonly hadBom: boolean;
}

/**
 * Reads a file and reports whether it carried a byte order mark.
 *
 * `TextDecoder` swallows the BOM by default, which is what readers want but
 * loses information a writer needs: decoding and writing back would silently
 * drop the mark. Decoding with `ignoreBOM` keeps it visible so the caller can
 * strip it deliberately and restore it afterwards.
 */
export async function readUtf8FileWithBom(
  absolutePath: string,
  displayPath: string,
  maxFileBytes: number,
): Promise<Utf8FileContents> {
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

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(contents);
  } catch (error) {
    throw new WorkspaceError(
      "invalid_utf8",
      `File is not valid UTF-8: ${displayPath}`,
      { cause: error },
    );
  }

  const hadBom = decoded.startsWith(UTF8_BOM);
  return { contents: hadBom ? decoded.slice(UTF8_BOM.length) : decoded, hadBom };
}

export async function readUtf8File(
  absolutePath: string,
  displayPath: string,
  maxFileBytes: number,
): Promise<string> {
  const { contents } = await readUtf8FileWithBom(
    absolutePath,
    displayPath,
    maxFileBytes,
  );
  return contents;
}

export function validateSearchQuery(query: string): void {
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

export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function boundedPositiveInteger(
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

export function splitLinesPreservingEndings(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }
  const lines = contents.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function splitLines(contents: string): string[] {
  return splitLinesPreservingEndings(contents).map((line) =>
    line.replace(/(?:\r\n|\r|\n)$/, ""),
  );
}

export function createMatchPreview(line: string, query: string): string {
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
