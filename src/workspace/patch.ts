import { unlink } from "node:fs/promises";
import { PatchError, applyHunks, parsePatch } from "../patch/parse.js";
import { resolveWritePath } from "./paths.js";
import { readFullTextFileWithBom } from "./read.js";
import { writeTextFile } from "./write.js";
import type { WorkspaceLimits } from "./types.js";

interface PlannedChange {
  readonly kind: "add" | "update" | "delete";
  readonly path: string;
  readonly previous: string | undefined;
  readonly next: string | undefined;
}
export interface PatchResult {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly deleted: readonly string[];
}

function interrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Patch interrupted.");
    error.name = "AbortError";
    throw error;
  }
}

async function readOriginal(limits: WorkspaceLimits, file: string): Promise<string> {
  const original = await readFullTextFileWithBom(limits, file);
  return (original.hadBom ? "\uFEFF" : "") + original.contents;
}

function checkContents(contents: string, limits: WorkspaceLimits, file: string): void {
  if (contents.includes("\0")) throw new PatchError(`Patch contains a NUL byte: ${file}`);
  if (Buffer.byteLength(contents, "utf8") > limits.maxFileBytes) {
    throw new PatchError(`Patched file exceeds the ${limits.maxFileBytes}-byte limit: ${file}`);
  }
}

/**
 * Validate *all* edits before modifying any file. Each individual replacement
 * uses the existing atomic workspace writer; if an I/O error occurs partway
 * through a batch, restore previously committed paths in reverse order.
 *
 * This is not a filesystem transaction: sudden process termination and
 * concurrent external writers can still expose partial changes.
 */
export async function applyWorkspacePatch(
  limits: WorkspaceLimits,
  text: string,
  signal?: AbortSignal,
): Promise<PatchResult> {
  const changes = parsePatch(text);
  const plan: PlannedChange[] = [];
  const paths = new Set<string>();
  for (const change of changes) {
    interrupted(signal);
    const resolved = await resolveWritePath(limits.root, change.path);
    const file = resolved.relativePath;
    if (paths.has(file)) throw new PatchError(`Duplicate normalized patch path: ${file}`);
    paths.add(file);
    if (change.kind === "add") {
      if (resolved.exists) throw new PatchError(`Add File already exists: ${file}`);
      const next = change.lines.length === 0 ? "" : `${change.lines.join("\n")}\n`;
      checkContents(next, limits, file);
      plan.push({ kind: "add", path: file, previous: undefined, next });
    } else {
      if (!resolved.exists) throw new PatchError(`${change.kind} target does not exist: ${file}`);
      const previous = await readOriginal(limits, file);
      if (change.kind === "delete") {
        plan.push({ kind: "delete", path: file, previous, next: undefined });
      } else {
        const bom = previous.startsWith("\uFEFF") ? "\uFEFF" : "";
        const contents = previous.slice(bom.length);
        // Retain uniform CRLF, rather than rewriting unrelated line endings.
        const crlf = contents.includes("\r\n") && !contents.replace(/\r\n/g, "").includes("\n") &&
          !contents.replace(/\r\n/g, "").includes("\r");
        const normalized = crlf ? contents.replace(/\r\n/g, "\n") : contents;
        const edited = applyHunks(normalized, change.hunks, file);
        const next = bom + (crlf ? edited.replace(/\n/g, "\r\n") : edited);
        if (next === previous) throw new PatchError(`Patch does not change ${file}`);
        checkContents(next, limits, file);
        plan.push({ kind: "update", path: file, previous, next });
      }
    }
  }

  // Two-phase validation: if any hunk conflicts, no file is touched.
  const committed: PlannedChange[] = [];
  try {
    for (const item of plan) {
      interrupted(signal);
      const target = await resolveWritePath(limits.root, item.path);
      if (target.exists !== (item.previous !== undefined)) {
        throw new PatchError(`File changed since validation: ${item.path}`);
      }
      if (item.previous !== undefined) {
        const current = await readOriginal(limits, item.path);
        if (current !== item.previous) throw new PatchError(`File changed since validation: ${item.path}`);
      }
      if (item.kind === "delete") {
        await unlink(target.lexicalTarget);
      } else {
        await writeTextFile(limits, item.path, item.next as string);
      }
      committed.push(item);
    }
  } catch (error: unknown) {
    const rollbackErrors: string[] = [];
    for (const item of committed.reverse()) {
      try {
        if (item.previous === undefined) {
          const target = await resolveWritePath(limits.root, item.path);
          if (target.exists) await unlink(target.lexicalTarget);
        } else {
          await writeTextFile(limits, item.path, item.previous);
        }
      } catch {
        rollbackErrors.push(item.path);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new PatchError(`Patch failed and rollback was incomplete for: ${rollbackErrors.join(", ")}. Inspect the workspace manually.`);
    }
    throw error;
  }

  return {
    added: plan.filter(item => item.kind === "add").map(item => item.path),
    updated: plan.filter(item => item.kind === "update").map(item => item.path),
    deleted: plan.filter(item => item.kind === "delete").map(item => item.path),
  };
}
