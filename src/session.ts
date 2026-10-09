import { Agent, type AgentOptions, type AgentRunResult } from "./agent.js";
import type { AgentEvent, AgentEventListener } from "./events.js";
import type { Message } from "./messages.js";
import { addUsage, type UsageTotal } from "./providers/usage.js";
import {
  createSessionId,
  SESSION_FORMAT_VERSION,
  type SessionHeader,
  type SessionStore,
  type SessionRecord,
} from "./session-store.js";

export interface AgentSessionOptions {
  /** Agent configuration. The session owns event delivery, so `onEvent` is not part of it. */
  readonly agent: Omit<AgentOptions, "onEvent">;
  readonly id?: string;
  readonly cwd?: string;
  readonly store?: SessionStore;
  /** Messages restored from an earlier session. */
  readonly messages?: readonly Message[];
  /** True when the session log already has a header line. */
  readonly resumed?: boolean;
  readonly now?: () => Date;
}

/**
 * Owns one conversation: the transcript that survives across prompts, the
 * listeners that watch it, and the optional durable log. The Agent stays
 * stateless between runs; the session is what makes a chivgent conversation
 * multi-turn.
 */
export class AgentSession {
  readonly id: string;
  readonly cwd: string;

  private readonly agent: Agent;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly store: SessionStore | undefined;
  private readonly now: () => Date;
  private transcript: readonly Message[];
  private headerWritten: boolean;
  private promptCount = 0;
  private promptInProgress = false;
  private usageTotal: UsageTotal | undefined;

  constructor(options: AgentSessionOptions) {
    this.id = options.id ?? createSessionId();
    this.cwd = options.cwd ?? process.cwd();
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.transcript = structuredClone(options.messages ?? []);
    this.headerWritten = options.resumed ?? false;
    this.agent = new Agent({
      ...options.agent,
      onEvent: (event) => {
        this.dispatch(event);
      },
    });
  }

  get messages(): readonly Message[] {
    return this.transcript;
  }

  get turns(): number {
    return this.promptCount;
  }

  /** What this session has cost so far, across every prompt. */
  get usage(): UsageTotal | undefined {
    return this.usageTotal;
  }

  get toolNames(): readonly string[] {
    return this.agent.toolNames;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drops the transcript but keeps the session id and its log. */
  clear(): void {
    if (this.promptInProgress) {
      throw new Error("Cannot clear a session while a prompt is running.");
    }
    this.transcript = [];
    this.record({ type: "session_clear" });
  }

  async prompt(
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    if (this.promptInProgress) {
      throw new Error("This session is already running a prompt.");
    }
    this.promptInProgress = true;

    try {
      await this.writeHeader();
      this.promptCount += 1;
      try {
        return await this.agent.run(text, {
          history: this.transcript,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } finally {
        // A Provider error still emits agent_end; flush that authoritative
        // snapshot so a restart restores the same transcript as this process.
        await this.flush();
      }
    } finally {
      this.promptInProgress = false;
    }
  }

  header(): SessionHeader {
    return {
      type: "session",
      version: SESSION_FORMAT_VERSION,
      id: this.id,
      timestamp: this.now().toISOString(),
      cwd: this.cwd,
    };
  }

  private dispatch(event: AgentEvent): void {
    // agent_end is authoritative even for an error (where agent.run throws).
    // Keep in-memory state and the persisted event snapshot identical.
    if (event.type === "agent_end") {
      this.transcript = structuredClone(event.messages);
      this.usageTotal = addUsage(this.usageTotal, event.usage?.usage);
      if (event.usage?.complete === false) {
        this.usageTotal = {
          usage: this.usageTotal.usage,
          complete: false,
        };
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not change the outcome of the run.
      }
    }
    this.record(event);
  }

  private record(event: SessionRecord): void {
    if (
      this.store === undefined ||
      !this.headerWritten ||
      event.type === "message_update" ||
      event.type === "tool_execution_update"
    ) {
      return;
    }
    // Events are emitted synchronously; the store serialises the writes.
    void this.store.append(this.id, event).catch(() => {
      // A session log is a convenience, never a reason to fail a run.
    });
  }

  private async writeHeader(): Promise<void> {
    if (this.store === undefined || this.headerWritten) {
      return;
    }
    try {
      await this.store.append(this.id, this.header());
      this.headerWritten = true;
    } catch {
      // Skip persistence for this run. A later prompt can retry the header.
    }
  }

  private async flush(): Promise<void> {
    try {
      await this.store?.flush?.();
    } catch {
      // Persistence is best-effort and must not change the Agent result.
    }
  }
}
