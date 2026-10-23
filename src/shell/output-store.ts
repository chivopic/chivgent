import { randomUUID } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { lstat, mkdtemp, open, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeShellOutput } from "./sanitize.js";

export const MAX_OUTPUT_READ_BYTES = 32 * 1024;
export const MAX_OUTPUT_READ_LINES = 200;
export const MAX_OUTPUT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_OUTPUT_SCAN_BYTES = MAX_OUTPUT_FILE_BYTES;
export const MAX_OUTPUT_SESSION_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_SESSION_FILES = 20;

const activeStores = new Set<ShellOutputStore>();
const cleanupStoresOnExit = (): void => {
  for (const store of activeStores) store.cleanupOnExit();
};

export type SavedOutputState = "complete" | "incomplete" | "unavailable";

interface StoredOutput {
  readonly path?: string;
  readonly state: SavedOutputState;
  readonly bytes: number;
  readonly lines: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly expiresAt: number;
}

export interface OutputReadResult {
  readonly content: string;
  readonly state: SavedOutputState;
  readonly startLine: number;
  readonly linesRead: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

/** Session-local capability map for shell spill files. IDs never encode paths. */
export class ShellOutputStore {
  private readonly parentDirectory: string;
  private readonly createTempDirectory: (parent: string) => Promise<string>;
  private readonly outputs = new Map<string, StoredOutput>();
  private directory: string | undefined;
  private directoryPromise: Promise<string> | undefined;
  private generation = 0;
  private closed = false;
  private sessionBytes = 0;

  constructor(options: { readonly tempDirectory?: string; readonly retentionMs?: number; readonly createTempDirectory?: (parent: string) => Promise<string> } = {}) {
    this.parentDirectory = options.tempDirectory ?? os.tmpdir();
    this.retentionMs = options.retentionMs ?? 60 * 60 * 1000;
    this.createTempDirectory = options.createTempDirectory ?? ((parent) => mkdtemp(path.join(parent, "chivgent-output-")));
  }

  private readonly retentionMs: number;

  maxBytesForNextOutput(): number {
    this.expire();
    if (this.closed || this.outputs.size >= MAX_OUTPUT_SESSION_FILES) return 0;
    return Math.min(MAX_OUTPUT_FILE_BYTES, Math.max(0, MAX_OUTPUT_SESSION_BYTES - this.sessionBytes));
  }

  async getTempDirectory(): Promise<string> {
    if (this.closed) throw new Error("Shell output store is closed.");
    if (this.directory !== undefined) return this.directory;
    if (this.directoryPromise !== undefined) return this.directoryPromise;
    const generation = this.generation;
    const creation = this.createTempDirectory(this.parentDirectory).then(async (directory) => {
      if (this.closed || generation !== this.generation) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw new Error("Shell output store is closed.");
      }
      this.directory = directory;
      if (activeStores.size === 0) process.once("exit", cleanupStoresOnExit);
      activeStores.add(this);
      return directory;
    }).finally(() => { if (this.directoryPromise === creation) this.directoryPromise = undefined; });
    this.directoryPromise = creation;
    return creation;
  }

  async register(filePath: string | undefined, bytes: number, lines: number, complete: boolean): Promise<{ id: string; state: SavedOutputState }> {
    const id = randomUUID();
    if (this.closed || filePath === undefined) return { id, state: "unavailable" };
    const directory = this.directory;
    if (directory === undefined || path.dirname(filePath) !== directory) return { id, state: "unavailable" };
    this.expire();
    let identity: Awaited<ReturnType<typeof lstat>>;
    try {
      identity = await lstat(filePath);
    } catch {
      return { id, state: "unavailable" };
    }
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) return { id, state: "unavailable" };
    const size = identity.size;
    if (this.outputs.size >= MAX_OUTPUT_SESSION_FILES) {
      await unlink(filePath).catch(() => undefined);
      return { id, state: "unavailable" };
    }
    if (size > MAX_OUTPUT_FILE_BYTES || this.sessionBytes + size > MAX_OUTPUT_SESSION_BYTES) {
      await unlink(filePath).catch(() => undefined);
      if (this.outputs.size < MAX_OUTPUT_SESSION_FILES) this.outputs.set(id, { state: "incomplete", bytes: 0, lines, expiresAt: Date.now() + this.retentionMs });
      return { id, state: "incomplete" };
    }
    const state = complete && bytes === size && bytes <= MAX_OUTPUT_FILE_BYTES ? "complete" : "incomplete";
    if (this.closed) return { id, state: "unavailable" };
    this.outputs.set(id, { path: filePath, dev: identity.dev, ino: identity.ino, state, bytes: size, lines, expiresAt: Date.now() + this.retentionMs });
    this.sessionBytes += size;
    return { id, state };
  }

  async read(id: string, startLine: number, lineCount: number): Promise<OutputReadResult> {
    this.expire();
    const entry = this.outputs.get(id);
    if (entry === undefined || this.closed) {
      return { content: "", state: "unavailable", startLine, linesRead: 0, totalLines: 0, truncated: false };
    }
    if (entry.path === undefined) {
      return { content: "", state: entry.state, startLine, linesRead: 0, totalLines: entry.lines, truncated: false };
    }
    if (startLine > entry.lines) {
      return { content: "", state: entry.state, startLine, linesRead: 0, totalLines: entry.lines, truncated: false };
    }
    const safeCount = Math.min(lineCount, MAX_OUTPUT_READ_LINES);
    let handle;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      const before = await lstat(entry.path);
      if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return { content: "", state: "unavailable", startLine, linesRead: 0, totalLines: entry.lines, truncated: false };
      handle = await open(entry.path, constants.O_RDONLY | noFollow);
      const [opened, named] = await Promise.all([handle.stat(), lstat(entry.path)]);
      if (named.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1 || named.nlink !== 1 || opened.ino !== named.ino || opened.dev !== named.dev || opened.ino !== entry.ino || opened.dev !== entry.dev) {
        return { content: "", state: "unavailable", startLine, linesRead: 0, totalLines: entry.lines, truncated: false };
      }
      const chunk = Buffer.alloc(8192);
      const decoder = new TextDecoder("utf-8");
      let position = 0;
      let currentLine = 1;
      let used = 0;
      let linesRead = 0;
      let truncated = false;
      let selected = "";
      let pending = "";
      while (position < MAX_OUTPUT_SCAN_BYTES && linesRead < safeCount) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, MAX_OUTPUT_SCAN_BYTES - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const text = decoder.decode(chunk.subarray(0, bytesRead), { stream: position < entry.bytes });
        for (const character of sanitizeShellOutput(text)) {
          if (currentLine >= startLine && linesRead < safeCount) {
            const bytes = Buffer.byteLength(character, "utf8");
            if (used + bytes > MAX_OUTPUT_READ_BYTES) {
              if (pending.length > 0) { selected += `${pending} [partial line; read byte limit reached]`; pending = ""; }
              truncated = true;
              break;
            }
            pending += character;
            used += bytes;
          }
          if (character === "\n") {
            if (currentLine >= startLine && linesRead < safeCount) {
              selected += pending;
              pending = "";
              linesRead += 1;
            }
            currentLine += 1;
          }
        }
        if (truncated) break;
        if (position >= entry.bytes) {
          const tail = decoder.decode();
          for (const character of sanitizeShellOutput(tail)) {
            if (currentLine >= startLine && linesRead < safeCount) pending += character;
            if (character === "\n") currentLine += 1;
          }
          break;
        }
      }
      if (position >= MAX_OUTPUT_SCAN_BYTES && (position < entry.bytes || (entry.state === "incomplete" && entry.bytes >= MAX_OUTPUT_SCAN_BYTES))) {
        truncated = true;
        // Do not present a scan-cap fragment as a whole line.
        if (pending.length > 0 && currentLine >= startLine && linesRead < safeCount) selected += `${pending} [partial line; scan limit reached]`;
      } else if (!truncated && pending.length > 0 && currentLine >= startLine && linesRead < safeCount) {
        selected += pending;
        linesRead += 1;
      }
      this.outputs.set(id, { ...entry, expiresAt: Date.now() + this.retentionMs });
      return { content: selected, state: entry.state, startLine, linesRead, totalLines: entry.lines, truncated };
    } catch {
      return { content: "", state: "unavailable", startLine, linesRead: 0, totalLines: entry.lines, truncated: false };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  cleanupOnExit(): void {
    if (this.directory !== undefined) { try { rmSync(this.directory, { recursive: true, force: true }); } catch { /* process exit cleanup is best-effort */ } }
  }

  clear(): void {
    this.generation += 1;
    this.outputs.clear();
    this.sessionBytes = 0;
    const directory = this.directory;
    this.directory = undefined;
    activeStores.delete(this);
    if (activeStores.size === 0) process.off("exit", cleanupStoresOnExit);
    if (directory !== undefined) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* cleanup is best-effort */ } }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.directoryPromise?.catch(() => undefined);
    this.clear();
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, entry] of this.outputs) {
      if (entry.expiresAt > now) continue;
      this.outputs.delete(id);
      this.sessionBytes = Math.max(0, this.sessionBytes - entry.bytes);
      if (entry.path !== undefined) void unlink(entry.path).catch(() => undefined);
    }
  }
}

export function validateOutputRead(value: unknown): { id: string; startLine: number; lineCount: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "startLine", "lineCount"].includes(key))) return undefined;
  if (typeof record.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(record.id)) return undefined;
  const startLine = record.startLine ?? 1;
  const lineCount = record.lineCount ?? 50;
  if (!Number.isSafeInteger(startLine) || (startLine as number) < 1 || !Number.isSafeInteger(lineCount) || (lineCount as number) < 1 || (lineCount as number) > MAX_OUTPUT_READ_LINES) return undefined;
  return { id: record.id, startLine: startLine as number, lineCount: lineCount as number };
}
