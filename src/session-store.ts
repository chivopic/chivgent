import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "./events.js";
import type { Message } from "./messages.js";
import type { AppliedCompaction } from "./context/context-manager.js";
import type { UsageTotal } from "./providers/usage.js";
import { addUsage } from "./providers/usage.js";
import { transcriptHash } from "./transcript-hash.js";

export const SESSION_FORMAT_VERSION = 1;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSIONS_DIRECTORY = "sessions";
const DEFAULT_LIST_LIMIT = 20;

export interface SessionHeader {
  readonly type: "session";
  readonly version: number;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
}

/**
 * One JSONL line. The header comes first, then the run events. `message_update`
 * deltas are not persisted: they are reconstructible from `message_end`, and
 * keeping them would make a session file grow with every token.
 */
export interface SessionClearRecord {
  readonly type: "session_clear";
}

export type SessionMetadataRecord =
  | { readonly type: "session_rename"; readonly title: string }
  | { readonly type: "session_plan_mode"; readonly enabled: boolean }
  | { readonly type: "session_usage"; readonly usage: UsageTotal }
  | { readonly type: "session_compaction"; readonly compaction: AppliedCompaction; readonly transcriptHash: string; readonly usage?: UsageTotal };

export type SessionRecord = SessionHeader | AgentEvent | SessionClearRecord | SessionMetadataRecord;

export interface SessionTranscript {
  readonly header: SessionHeader;
  readonly messages: readonly Message[];
  readonly prompts: readonly string[];
  readonly compaction?: AppliedCompaction;
  readonly usage?: UsageTotal;
  readonly promptCount: number;
  readonly title?: string;
  readonly planMode: boolean;
}

export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
  readonly updatedAt: string;
  readonly promptCount: number;
  readonly title?: string;
  readonly planMode: boolean;
  readonly lastPrompt?: string;
}

export interface SessionListOptions {
  /** Keep only sessions recorded for this workspace. */
  readonly cwd?: string;
  readonly limit?: number;
}

export interface SessionStore {
  append(id: string, record: SessionRecord): Promise<void>;
  read(id: string): Promise<SessionTranscript | undefined>;
  list(options?: SessionListOptions): Promise<readonly SessionSummary[]>;
  location(id: string): string;
  /** Resolves once every queued append has settled. */
  flush?(): Promise<void>;
}

export function defaultSessionHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CHIVGENT_HOME;
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(os.homedir(), ".chivgent");
}

export function createSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Appends session records as JSON lines under `<home>/sessions/<id>.jsonl`.
 * Writes are serialised per session so events keep their emission order.
 */
export class FileSessionStore implements SessionStore {
  private readonly directory: string;
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(home: string = defaultSessionHome()) {
    this.directory = path.join(home, SESSIONS_DIRECTORY);
  }

  location(id: string): string {
    return path.join(this.directory, `${assertSessionId(id)}.jsonl`);
  }

  append(id: string, record: SessionRecord): Promise<void> {
    const file = this.location(id);
    const line = `${JSON.stringify(record)}\n`;
    const write = this.pendingWrites.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(file, line, "utf8");
    });

    // Keep the queue usable after an individual write fails. The caller still
    // receives `write` and can observe that failure, while later appends are
    // chained from a recovered promise instead of a permanently rejected one.
    this.pendingWrites = write.catch(() => undefined);
    return write;
  }

  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  async read(id: string): Promise<SessionTranscript | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.location(id), "utf8");
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    return parseTranscript(contents);
  }

  async list(
    options: SessionListOptions = {},
  ): Promise<readonly SessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const summary = await this.summarise(path.join(this.directory, file));
      if (summary === undefined) {
        continue;
      }
      if (options.cwd !== undefined && summary.cwd !== options.cwd) {
        continue;
      }
      summaries.push(summary);
    }

    return summaries
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, options.limit ?? DEFAULT_LIST_LIMIT);
  }

  private async summarise(file: string): Promise<SessionSummary | undefined> {
    let transcript: SessionTranscript | undefined;
    let updatedAt: string;
    try {
      transcript = parseTranscript(await readFile(file, "utf8"));
      updatedAt = (await stat(file)).mtime.toISOString();
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    if (transcript === undefined) {
      return undefined;
    }

    const lastPrompt = transcript.prompts.at(-1);
    return {
      id: transcript.header.id,
      cwd: transcript.header.cwd,
      timestamp: transcript.header.timestamp,
      updatedAt,
      promptCount: transcript.prompts.length,
      planMode: transcript.planMode,
      ...(transcript.title === undefined ? {} : { title: transcript.title }),
      ...(lastPrompt === undefined ? {} : { lastPrompt }),
    };
  }
}

/**
 * Rebuilds a transcript from a session file. The authoritative message list is
 * the one carried by the last `agent_end`, so a partially written file degrades
 * to the last completed run instead of failing to load. A session_clear record
 * resets that snapshot even if there is no subsequent run.
 */
export function parseTranscript(
  contents: string,
): SessionTranscript | undefined {
  let header: SessionHeader | undefined;
  let messages: readonly Message[] = [];
  const prompts: string[] = [];
  let compaction: AppliedCompaction | undefined;
  let usage: UsageTotal | undefined;
  let promptCount = 0;
  let title: string | undefined;
  let planMode = false;

  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A truncated final line must not discard the session.
    }
    if (typeof record !== "object" || record === null || !("type" in record)) {
      continue;
    }

    if (record.type === "session") {
      header = toHeader(record);
    } else if (record.type === "session_rename" && "title" in record && typeof record.title === "string" && record.title.trim().length > 0 && record.title.length <= 120 && !/[\x00-\x1f\x7f]/.test(record.title)) {
      title = record.title;
    } else if (record.type === "session_plan_mode" && "enabled" in record && typeof record.enabled === "boolean") {
      planMode = record.enabled;
    } else if (record.type === "session_usage" && "usage" in record) {
      const savedUsage = validUsage(record.usage);
      if (savedUsage !== undefined) usage = savedUsage;
    } else if (record.type === "session_compaction" && "compaction" in record && "transcriptHash" in record) {
      const candidate = record as { compaction: unknown; transcriptHash: unknown; usage?: unknown };
      if (candidate.transcriptHash === transcriptHash(messages)) compaction = validCompaction(candidate.compaction, messages);
      const savedUsage = validUsage(candidate.usage);
      if (savedUsage !== undefined) usage = savedUsage;
    } else if (record.type === "session_clear") {
      messages = [];
      compaction = undefined;
      usage = undefined;
      prompts.length = 0;
      promptCount = 0;
    } else if (record.type === "agent_start" && "prompt" in record) {
      if (typeof record.prompt === "string") {
        prompts.push(record.prompt);
      }
    } else if (record.type === "agent_end" && "messages" in record) {
      if (Array.isArray(record.messages)) {
        messages = record.messages as readonly Message[];
        const end = record as { compaction?: unknown; sessionUsage?: unknown; compactionTranscriptHash?: unknown; usage?: unknown; turnCount?: unknown; directShellSnapshot?: unknown };
        compaction = end.compactionTranscriptHash === transcriptHash(messages)
          ? validCompaction(end.compaction, messages) : undefined;
        const savedUsage = validUsage(end.sessionUsage);
        if (savedUsage !== undefined) {
          usage = savedUsage;
        } else if (end.directShellSnapshot !== true) {
          // A direct shell shortcut writes a transcript snapshot with no model
          // turn. Do not turn that bookkeeping record into missing provider
          // usage or a synthetic incomplete usage total.
          const runUsage = validUsage(end.usage);
          usage = addUsage(usage, runUsage?.usage);
          if (runUsage?.complete === false) usage = { usage: usage.usage, complete: false };
        }
        if (Number.isSafeInteger((record as { promptCount?: unknown }).promptCount)) {
          promptCount = (record as unknown as { promptCount: number }).promptCount;
        }
      }
    }
  }

  promptCount = Math.max(promptCount, prompts.length);
  return header === undefined ? undefined : { header, messages, prompts, promptCount, planMode, ...(title === undefined ? {} : { title }), ...(compaction === undefined ? {} : { compaction }), ...(usage === undefined ? {} : { usage }) };
}

function validCompaction(value: unknown, messages: readonly Message[]): AppliedCompaction | undefined {
  if (typeof value !== "object" || value === null || !("splitIndex" in value) || !("state" in value)) return undefined;
  const c = value as { splitIndex: unknown; anchorIndex?: unknown; manualTranscriptLength?: unknown; state: unknown };
  if (!Number.isSafeInteger(c.splitIndex) || (c.splitIndex as number) < 0 || (c.splitIndex as number) > messages.length || messages[c.splitIndex as number]?.role === "tool") return undefined;
  if ("anchorIndex" in value && c.anchorIndex !== undefined) {
    if (!Number.isSafeInteger(c.anchorIndex) || (c.anchorIndex as number) < 0 ||
      (c.anchorIndex as number) >= (c.splitIndex as number) || messages[c.anchorIndex as number]?.role !== "user") return undefined;
  }
  if ("manualTranscriptLength" in value && c.manualTranscriptLength !== undefined &&
    (!Number.isSafeInteger(c.manualTranscriptLength) || (c.manualTranscriptLength as number) < 0 || (c.manualTranscriptLength as number) > messages.length)) return undefined;
  if (typeof c.state !== "object" || c.state === null || !("summary" in c.state) ||
    typeof c.state.summary !== "string" || !("readFiles" in c.state) || !Array.isArray(c.state.readFiles) ||
    !("modifiedFiles" in c.state) || !Array.isArray(c.state.modifiedFiles) || !("decisions" in c.state) ||
    !Array.isArray(c.state.decisions) || !("pendingTasks" in c.state) || !Array.isArray(c.state.pendingTasks) ||
    ![...c.state.readFiles, ...c.state.modifiedFiles, ...c.state.decisions, ...c.state.pendingTasks].every((item) => typeof item === "string")) return undefined;
  return value as AppliedCompaction;
}

function validUsage(value: unknown): UsageTotal | undefined {
  if (typeof value !== "object" || value === null || !("usage" in value) || !("complete" in value)) return undefined;
  const u = value as UsageTotal;
  const validToken = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (typeof u.usage !== "object" || u.usage === null ||
    !validToken(u.usage.inputTokens) || !validToken(u.usage.outputTokens) || !validToken(u.usage.totalTokens) ||
    (u.usage.cachedInputTokens !== undefined && !validToken(u.usage.cachedInputTokens)) ||
    (u.usage.reasoningTokens !== undefined && !validToken(u.usage.reasoningTokens)) ||
    typeof u.complete !== "boolean") return undefined;
  return u;
}

function toHeader(record: object): SessionHeader | undefined {
  const candidate = record as Partial<SessionHeader>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.timestamp !== "string" ||
    typeof candidate.version !== "number"
  ) {
    return undefined;
  }
  return {
    type: "session",
    version: candidate.version,
    id: candidate.id,
    timestamp: candidate.timestamp,
    cwd: candidate.cwd,
  };
}

function assertSessionId(id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new TypeError(`Invalid session id: ${id}`);
  }
  return id;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
