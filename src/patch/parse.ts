/** Strict, bounded subset of Codex's *** Begin Patch format. */
export interface PatchHunk {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}
export type PatchChange =
  | { readonly kind: "add"; readonly path: string; readonly lines: readonly string[] }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly hunks: readonly PatchHunk[] };

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_FILES = 20;

export function parsePatch(patch: string): readonly PatchChange[] {
  if (typeof patch !== "string" || Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    throw new PatchError("Patch must be a string no larger than 256 KiB.");
  }
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new PatchError("Patch must begin with *** Begin Patch and end with *** End Patch.");
  }

  const changes: PatchChange[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < lines.length) {
    const header = /^(\*\*\* (Add File|Delete File|Update File): )(.+)$/.exec(lines[cursor] ?? "");
    if (header === null) throw new PatchError(`Expected file header on patch line ${cursor + 2}.`);
    const kind = header[2];
    const file = header[3] ?? "";
    if (file.trim() !== file || file.length === 0) {
      throw new PatchError("Patch file paths must not be empty or padded.");
    }
    if (seen.has(file)) throw new PatchError(`Duplicate patch path: ${file}`);
    seen.add(file);
    cursor += 1;
    if (changes.length >= MAX_FILES) throw new PatchError("Patch exceeds the 20-file limit.");

    if (kind === "Add File") {
      const content: string[] = [];
      while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("*** ")) {
        const line = lines[cursor] ?? "";
        if (!line.startsWith("+")) throw new PatchError(`Add File ${file} accepts only + lines.`);
        content.push(line.slice(1));
        cursor += 1;
      }
      changes.push({ kind: "add", path: file, lines: content });
    } else if (kind === "Delete File") {
      changes.push({ kind: "delete", path: file });
    } else {
      const hunks: PatchHunk[] = [];
      while (cursor < lines.length && !(lines[cursor] ?? "").startsWith("*** ")) {
        if (lines[cursor] !== "@@") {
          throw new PatchError(`Update File ${file} requires @@ hunks (no fuzzy context hints).`);
        }
        cursor += 1;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        while (cursor < lines.length && lines[cursor] !== "@@" && !(lines[cursor] ?? "").startsWith("*** ")) {
          const line = lines[cursor] ?? "";
          const prefix = line.slice(0, 1);
          if (prefix !== " " && prefix !== "-" && prefix !== "+") {
            throw new PatchError(`Unexpected hunk line for ${file}; expected space, - or +.`);
          }
          if (prefix !== "+") oldLines.push(line.slice(1));
          if (prefix !== "-") newLines.push(line.slice(1));
          cursor += 1;
        }
        if (oldLines.length === 0 || (oldLines.join("\n") === newLines.join("\n"))) {
          throw new PatchError(`Hunk for ${file} must replace anchored text with a change.`);
        }
        hunks.push({ oldLines, newLines });
      }
      if (hunks.length === 0) throw new PatchError(`Update File ${file} requires at least one @@ hunk.`);
      changes.push({ kind: "update", path: file, hunks });
    }
  }
  if (changes.length === 0) throw new PatchError("Patch contains no file changes.");
  return changes;
}

/** Apply exact line-anchored hunks; never guess where ambiguous text belongs. */
export function applyHunks(original: string, hunks: readonly PatchHunk[], file: string): string {
  const hasFinalNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hasFinalNewline) lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const matches: number[] = [];
    for (let start = cursor; start + hunk.oldLines.length <= lines.length; start += 1) {
      if (hunk.oldLines.every((line, index) => lines[start + index] === line)) matches.push(start);
    }
    if (matches.length === 0) throw new PatchError(`Patch context not found in ${file}; re-read the file.`);
    if (matches.length !== 1) throw new PatchError(`Ambiguous patch context in ${file}; add more surrounding lines.`);
    const at = matches[0] as number;
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    cursor = at + hunk.newLines.length;
  }
  return lines.join("\n") + (hasFinalNewline ? "\n" : "");
}
