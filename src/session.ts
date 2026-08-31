import { Agent, type AgentOptions, type AgentRunResult } from "./agent.js";
import type { CompactionResult, ContextStatus } from "./context.js";
import type { AgentEvent, AgentEventListener } from "./events.js";
import type { Message } from "./messages.js";
import {
  addUsage,
  EMPTY_USAGE,
  type RequestShape,
  type TokenUsage,
} from "./tokens.js";
import {
  createSessionId,
  SESSION_FORMAT_VERSION,
  type SessionHeader,
  type SessionStore,
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
  private readonly systemPrompt: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly store: SessionStore | undefined;
  private readonly context: AgentOptions["context"];
  private readonly now: () => Date;
  private transcript: readonly Message[];
  private headerWritten: boolean;
  private promptCount = 0;
  private totalUsage: TokenUsage = EMPTY_USAGE;

  constructor(options: AgentSessionOptions) {
    this.id = options.id ?? createSessionId();
    this.cwd = options.cwd ?? process.cwd();
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.transcript = structuredClone(options.messages ?? []);
    this.headerWritten = options.resumed ?? false;
    this.systemPrompt = options.agent.systemPrompt;
    this.context = options.agent.context;
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

  get toolNames(): readonly string[] {
    return this.agent.toolNames;
  }

  /** Provider-reported totals across every prompt in this session. */
  get usage(): TokenUsage {
    return this.totalUsage;
  }

  /** What the next request would cost, or undefined when no budget is set. */
  contextStatus(): ContextStatus | undefined {
    return this.context?.status(this.requestShape());
  }

  /**
   * Compacts the transcript now, whether or not it is over budget. Used by the
   * REPL's `/compact`; automatic compaction happens inside the Agent Loop.
   */
  async compact(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CompactionResult | undefined> {
    if (this.context === undefined) {
      return undefined;
    }

    const shape = this.requestShape();
    const status = this.context.status(shape);
    this.dispatch({
      type: "compaction_start",
      turn: 0,
      estimatedTokens: status.estimatedTokens,
      budgetTokens: status.budgetTokens,
    });

    const compacted = await this.context.compact(shape, {
      force: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (compacted === undefined) {
      return undefined;
    }

    this.transcript = compacted.messages;
    this.dispatch({
      type: "compaction_end",
      turn: 0,
      beforeTokens: compacted.beforeTokens,
      afterTokens: compacted.afterTokens,
      summarisedMessages: compacted.summarisedMessages,
      shrunkToolResults: compacted.shrunkToolResults,
      droppedMessages: compacted.droppedMessages,
      degraded: compacted.degraded,
    });
    return compacted;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drops the transcript but keeps the session id and its log. */
  clear(): void {
    this.transcript = [];
  }

  async prompt(
    text: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    await this.writeHeader();
    this.promptCount += 1;

    const result = await this.agent.run(text, {
      history: this.transcript,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    this.transcript = result.messages;
    this.totalUsage = addUsage(this.totalUsage, result.usage);
    await this.flush();
    return result;
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

  private requestShape(): RequestShape {
    return {
      systemPrompt: this.systemPrompt,
      messages: this.transcript,
      tools: this.agent.tools,
    };
  }

  private dispatch(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not change the outcome of the run.
      }
    }
    this.record(event);
  }

  private record(event: AgentEvent): void {
    if (this.store === undefined || event.type === "message_update") {
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
    this.headerWritten = true;
    await this.store.append(this.id, this.header());
  }

  private async flush(): Promise<void> {
    await this.store?.flush?.();
  }
}
