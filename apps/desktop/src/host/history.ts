import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, unlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent } from "@chivgent/events.ts";
import type { Message } from "@chivgent/messages.ts";
import type { AppliedCompaction } from "@chivgent/context/context-manager.ts";

const FORMAT_VERSION = 1;

export function readLastProject(directory: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(directory, "last-project.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== FORMAT_VERSION || typeof (parsed as { projectPath?: unknown }).projectPath !== "string" || !(parsed as { projectPath: string }).projectPath) throw new Error("上次项目元数据损坏或版本不受支持。");
  return (parsed as { projectPath: string }).projectPath;
}

export function saveLastProject(directory: string, projectPath: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.last-project-${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify({ version: FORMAT_VERSION, projectPath })); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, join(directory, "last-project.json"));
}

export interface HistoryEvent {
  readonly type: "event";
  readonly sequence: number;
  readonly runId: string;
  readonly event: AgentEvent | DesktopApprovalHistoryEvent;
}

export type DesktopApprovalHistoryEvent =
  | { readonly type: "approval_requested"; readonly approvalId: string; readonly action: string; readonly context: string }
  | { readonly type: "approval_decision"; readonly approvalId: string; readonly approved: boolean; readonly reason?: "user" | "cancelled" | "journal_failed" };

export interface HistoryContext {
  readonly type: "context";
  readonly messages: readonly Message[];
  readonly compaction?: AppliedCompaction;
}

export interface HistoryRun {
  readonly type: "run";
  readonly runId: string;
  readonly prompt: string;
  readonly status: "started" | "completed" | "interrupted" | "unknown";
}

type Entry = { readonly version: 1; readonly value: HistoryEvent | HistoryContext | HistoryRun };

export interface LoadedHistory {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly events: readonly HistoryEvent[];
  readonly messages?: readonly Message[];
  readonly compaction?: AppliedCompaction;
  readonly activeRun?: HistoryRun;
  readonly runs: readonly HistoryRun[];
  readonly incomplete: boolean;
  readonly corruption: "tail" | "middle" | "uncertain" | null;
}

/** A conservative single-writer, append-only journal for one desktop session. */
export class DesktopHistory {
  readonly sessionId: string;
  private readonly projectPath: string;
  private readonly logPath: string;
  private readonly intentPath: string;
  private readonly directory: string;
  private readonly lockPath: string;
  private readonly lockFd: number;
  private corruption: "tail" | "middle" | "uncertain" | null;
  private closed = false;
  private entries: Entry[];

  private constructor(directory: string, projectPath: string, entries: Entry[], lockFd: number, corruption: "tail" | "middle" | "uncertain" | null) {
    this.directory = directory;
    this.projectPath = projectPath;
    this.sessionId = `session-${createHash("sha256").update(projectPath).digest("hex").slice(0, 24)}`;
    this.logPath = join(directory, `${this.sessionId}.jsonl`);
    this.intentPath = join(directory, `${this.sessionId}.intent`);
    this.lockPath = join(directory, `${this.sessionId}.lock`);
    this.entries = entries;
    this.lockFd = lockFd;
    this.corruption = corruption;
    if (this.corruption === null && !existsSync(this.logPath)) closeSync(openSync(this.logPath, "wx", 0o600));
  }

  static open(directory: string, projectPath: string): DesktopHistory {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sessionId = `session-${createHash("sha256").update(projectPath).digest("hex").slice(0, 24)}`;
    const lockPath = join(directory, `${sessionId}.lock`);
    const lockFd = acquireLock(lockPath, sessionId);
    try {
      writeAll(lockFd, Buffer.from(JSON.stringify({ pid: process.pid, sessionId })));
      fsyncSync(lockFd);
      const logPath = join(directory, `${sessionId}.jsonl`);
      const intent = readIntent(join(directory, `${sessionId}.intent`));
      const loaded = readEntries(logPath, intent === undefined ? undefined : intent.offset);
      return new DesktopHistory(directory, projectPath, loaded.entries, lockFd, intent === undefined ? loaded.corruption : "uncertain");
    }
    catch (error) {
      try { closeSync(lockFd); } catch { /* Preserve the original failure. */ }
      try { unlinkSync(lockPath); } catch { /* A stale lock is safer than losing the failure. */ }
      throw error;
    }
  }

  snapshot(): LoadedHistory {
    let context: HistoryContext | undefined;
    let activeRun: HistoryRun | undefined;
    const runById = new Map<string, HistoryRun>();
    const events: HistoryEvent[] = [];
    for (const entry of this.entries) {
      const value = entry.value;
      if (value.type === "context") context = value;
      else if (value.type === "event") events.push(value);
      else if (value.runId !== "") { activeRun = value; runById.set(value.runId, value); }
    }
    if (activeRun?.status === "started") {
      activeRun = { ...activeRun, status: "interrupted" };
    }
    return {
      sessionId: this.sessionId,
      projectPath: this.projectPath,
      events,
      ...(context === undefined || this.corruption !== null ? {} : { messages: context.messages, ...(context.compaction === undefined ? {} : { compaction: context.compaction }) }),
      ...(activeRun === undefined ? {} : { activeRun }),
      runs: [...runById.values()].map((run) => run.status === "started" ? { ...run, status: "interrupted" as const } : run),
      incomplete: this.corruption !== null,
      corruption: this.corruption,
    };
  }

  appendEvent(value: HistoryEvent): void { this.append(value); }
  saveContext(messages: readonly Message[], compaction?: AppliedCompaction): void {
    this.append({ type: "context", messages, ...(compaction === undefined ? {} : { compaction }) });
  }
  saveRun(run: HistoryRun): void { this.append(run); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.lockFd);
    try { unlinkSync(this.lockPath); } catch { /* Keep stale lock if cleanup fails. */ }
  }

  private append(value: HistoryEvent | HistoryContext | HistoryRun): void {
    if (this.closed) throw new Error("Desktop history is closed.");
    if (this.corruption !== null) throw new Error("历史记录不完整或写入状态未知，已进入只读恢复状态。");
    const entry: Entry = { version: FORMAT_VERSION, value: redact(value) as typeof value };
    const fd = openSync(this.logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("历史日志不是普通文件。");
      const offset = stat.size;
      // The durable marker establishes the last reliable prefix before any log bytes are written.
      this.corruption = "uncertain";
      const markerFd = openSync(this.intentPath, "wx", 0o600);
      try {
        writeAll(markerFd, Buffer.from(JSON.stringify({ version: FORMAT_VERSION, offset })));
        fsyncSync(markerFd);
      } finally { closeSync(markerFd); }
      syncDirectory(this.directory);
      writeAll(fd, Buffer.from(`${JSON.stringify(entry)}\n`));
      fsyncSync(fd);
      closeSync(fd);
      this.entries.push(entry);
      unlinkSync(this.intentPath);
      // The log fsync is the commit point. An unsynced marker deletion may
      // reappear after power loss, in which case recovery remains conservative.
      this.corruption = null;
    } catch (error) {
      try { closeSync(fd); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0 || written > bytes.length - offset) throw new Error("历史记录写入没有进展。");
    offset += written;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIntent(path: string): { offset: number } | undefined {
  try {
    const bytes = readRegularFile(path);
    if (bytes === undefined) return undefined;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== FORMAT_VERSION || !Number.isSafeInteger((value as { offset?: unknown }).offset) || ((value as { offset: number }).offset < 0)) return { offset: 0 };
    return { offset: (value as { offset: number }).offset };
  } catch (error) {
    return { offset: 0 };
  }
}

function readRegularFile(path: string): Buffer | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling symlink is an existing, untrusted entry, not an absent file.
      try { lstatSync(path); }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw statError;
      }
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("历史文件不是普通文件。");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function readEntries(path: string, offset?: number): { entries: Entry[]; corruption: "tail" | "middle" | null } {
  const bytes = readRegularFile(path);
  if (bytes === undefined) return { entries: [], corruption: null };
  // An invalid offset must never authorize accepting any unconfirmed bytes.
  const boundary = offset === undefined ? bytes.length : offset <= bytes.length && (offset === 0 || bytes[offset - 1] === 10) ? offset : 0;
  const text = bytes.subarray(0, boundary).toString("utf8");
  const lines = text.split("\n");
  const entries: Entry[] = [];
  let corruption: "tail" | "middle" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!validEntry(parsed)) throw new Error("invalid history record");
      entries.push(parsed);
    } catch {
      corruption = index === lines.length - 1 || (index === lines.length - 2 && lines.at(-1) === "") ? "tail" : "middle";
      break;
    }
  }
  return { entries, corruption };
}

function validEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { version?: unknown; value?: { type?: unknown } };
  if (item.version !== FORMAT_VERSION || typeof item.value !== "object" || item.value === null) return false;
  const record = item.value as Record<string, unknown>;
  if (record.type === "run") return typeof record.runId === "string" && typeof record.prompt === "string" && ["started", "completed", "interrupted", "unknown"].includes(String(record.status));
  if (record.type === "context") return Array.isArray(record.messages) && record.messages.every(validMessage) &&
    (record.compaction === undefined || validCompaction(record.compaction, record.messages));
  if (record.type === "event") return Number.isSafeInteger(record.sequence) && typeof record.runId === "string" && typeof record.event === "object" && record.event !== null && typeof (record.event as { type?: unknown }).type === "string";
  return false;
}

function acquireLock(path: string, sessionId: string): number {
  try { return openSync(path, "wx", 0o600); }
  catch (error) {
    if (!existsSync(path)) throw error;
    const original = readLock(path);
    const pid = original?.pid;
    if (pid === undefined || pid === process.pid) throw new Error(`历史会话 ${sessionId} 正由另一个写入者使用。`);
    try { process.kill(pid, 0); throw new Error(`历史会话 ${sessionId} 正由进程 ${pid} 使用。`); }
    catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError; }
    const reclaimPath = `${path}.reclaim`;
    let reclaimFd: number;
    try { reclaimFd = openSync(reclaimPath, "wx", 0o600); }
    catch { throw new Error(`历史会话 ${sessionId} 正在回收锁，请稍后重试。`); }
    try {
      if (original === undefined) throw new Error(`历史会话 ${sessionId} 的锁格式无效。`);
      const current = readLock(path);
      if (current?.pid !== original.pid || current.sessionId !== original.sessionId) throw new Error("历史写入锁在回收期间发生变化。");
      try { process.kill(current.pid, 0); throw new Error(`历史会话 ${sessionId} 正由进程 ${current.pid} 使用。`); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError; }
      unlinkSync(path);
      return openSync(path, "wx", 0o600);
    } finally {
      closeSync(reclaimFd);
      unlinkSync(reclaimPath);
    }
  }
}

function readLock(path: string): { pid: number; sessionId: string } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && Number.isSafeInteger((value as { pid?: unknown }).pid) && typeof (value as { sessionId?: unknown }).sessionId === "string") return value as { pid: number; sessionId: string };
  } catch { /* An unreadable lock is held; never guess that its owner is dead. */ }
  return undefined;
}

function validMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") return typeof message.content === "string";
  if (message.role === "assistant") return typeof message.content === "string" && Array.isArray(message.toolCalls) && message.toolCalls.every((call) => typeof call === "object" && call !== null && typeof (call as { id?: unknown }).id === "string" && typeof (call as { name?: unknown }).name === "string" && "arguments" in call);
  if (message.role === "tool") return typeof message.content === "string" && typeof message.toolCallId === "string" && typeof message.toolName === "string" && typeof message.isError === "boolean";
  return false;
}

function validCompaction(value: unknown, messages: readonly unknown[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const compaction = value as Record<string, unknown>;
  const state = compaction.state as Record<string, unknown> | null;
  if (!Number.isSafeInteger(compaction.splitIndex) || (compaction.splitIndex as number) < 0 || (compaction.splitIndex as number) > messages.length || state === null || typeof state !== "object" || typeof state.summary !== "string") return false;
  for (const key of ["readFiles", "modifiedFiles", "decisions", "pendingTasks"]) if (!Array.isArray(state[key]) || !(state[key] as unknown[]).every((item) => typeof item === "string")) return false;
  if (compaction.anchorIndex !== undefined && (!Number.isSafeInteger(compaction.anchorIndex) || (compaction.anchorIndex as number) < 0 || (compaction.anchorIndex as number) >= (compaction.splitIndex as number) || (messages[compaction.anchorIndex as number] as { role?: unknown } | undefined)?.role !== "user")) return false;
  if (compaction.manualTranscriptLength !== undefined && (!Number.isSafeInteger(compaction.manualTranscriptLength) || (compaction.manualTranscriptLength as number) < 0 || (compaction.manualTranscriptLength as number) > messages.length)) return false;
  return true;
}

function redact<T>(value: T): T {
  const secret = /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(["']?\s*[:=]\s*["']?)[^\s,"'}]{6,})/gi;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(secret, "[REDACTED]");
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item === "object" && item !== null) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, /^(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key) ? "[REDACTED]" : walk(child)]));
    return item;
  };
  return walk(value) as T;
}
