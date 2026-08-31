import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "./events.js";
import type { Message } from "./messages.js";

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
export type SessionRecord = SessionHeader | AgentEvent;

export interface SessionTranscript {
  readonly header: SessionHeader;
  readonly messages: readonly Message[];
  readonly prompts: readonly string[];
}

export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
  readonly updatedAt: string;
  readonly promptCount: number;
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
  /** Resolves once every queued append has been written. */
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
  private pendingWrites: Promise<unknown> = Promise.resolve();

  constructor(home: string = defaultSessionHome()) {
    this.directory = path.join(home, SESSIONS_DIRECTORY);
  }

  location(id: string): string {
    return path.join(this.directory, `${assertSessionId(id)}.jsonl`);
  }

  async append(id: string, record: SessionRecord): Promise<void> {
    const file = this.location(id);
    const line = `${JSON.stringify(record)}\n`;
    this.pendingWrites = this.pendingWrites.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(file, line, "utf8");
    });
    return this.pendingWrites as Promise<void>;
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
      ...(lastPrompt === undefined ? {} : { lastPrompt }),
    };
  }
}

/**
 * Rebuilds a transcript from a session file. The authoritative message list is
 * the one carried by the last `agent_end`, so a partially written file degrades
 * to the last completed run instead of failing to load.
 */
export function parseTranscript(
  contents: string,
): SessionTranscript | undefined {
  let header: SessionHeader | undefined;
  let messages: readonly Message[] = [];
  const prompts: string[] = [];

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
    } else if (record.type === "agent_start" && "prompt" in record) {
      if (typeof record.prompt === "string") {
        prompts.push(record.prompt);
      }
    } else if (record.type === "agent_end" && "messages" in record) {
      if (Array.isArray(record.messages)) {
        messages = record.messages as readonly Message[];
      }
    }
  }

  return header === undefined ? undefined : { header, messages, prompts };
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
