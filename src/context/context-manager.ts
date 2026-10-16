import type { Message } from "../messages.js";
import type { Usage } from "../llm.js";
import {
  Compactor,
  renderCompactionState,
  type CompactionState,
} from "./compaction.js";
import {
  HeuristicTokenEstimator,
  type TokenEstimator,
} from "./token-estimator.js";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export interface ContextManagerOptions {
  readonly contextWindow?: number;
  /** Head-room left for the model's own reply and for estimator error. */
  readonly reserveTokens?: number;
  /** Roughly how much recent conversation survives a compaction verbatim. */
  readonly keepRecentTokens?: number;
  readonly estimator?: TokenEstimator;
  /** Omit to disable compaction; the transcript is then passed through. */
  readonly compactor?: Compactor;
  readonly onCompaction?: (event: CompactionEvent) => void;
}

export interface CompactionEvent {
  readonly droppedMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly state: CompactionState;
}

export interface AppliedCompaction {
  readonly state: CompactionState;
  /** Index into the full transcript where verbatim history resumes. */
  readonly splitIndex: number;
  /** Preserve the active prompt before a compacted run of later tool turns. */
  readonly anchorIndex?: number;
}

export interface BuildOptions {
  /** The compaction already in force, so it is not recomputed every turn. */
  readonly previous?: AppliedCompaction;
  readonly signal?: AbortSignal;
  /** Extra uncompactable project guidance the caller prepends to the request. */
  readonly prefixMessages?: readonly Message[];
  /** Request-level fixed context such as the system prompt and tool schemas. */
  readonly fixedMessages?: readonly Message[];
}

export interface BuiltContext {
  readonly messages: readonly Message[];
  /**
   * True when this call summarised history. Providers that chain history
   * server-side must discard their continuation when this is set: with a
   * continuation they replay their own stored history and ignore the messages
   * in the request, which would carry back the very history just removed.
   */
  readonly compacted: boolean;
  readonly estimatedTokens: number;
  /** Carry this into the next build to reuse the summary. */
  readonly compaction?: AppliedCompaction;
  /** What summarising cost, so the run's total can include it. */
  readonly usage?: Usage;
}

/**
 * Decides what the model sees for one request.
 *
 * The session owns what happened; this owns what is worth sending. Keeping
 * them apart is what lets a long session stay inside a fixed context window.
 */
export class ContextManager {
  private readonly contextWindow: number;
  private readonly reserveTokens: number;
  private readonly keepRecentTokens: number;
  private readonly estimator: TokenEstimator;
  private readonly compactor?: Compactor;
  private readonly onCompaction?: (event: CompactionEvent) => void;

  constructor(options: ContextManagerOptions = {}) {
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    // A small window must still leave room to reply, so the fixed reserve is
    // capped at a share of the window rather than applied blindly.
    this.reserveTokens =
      options.reserveTokens ??
      Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(this.contextWindow / 4));
    this.keepRecentTokens =
      options.keepRecentTokens ??
      Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.floor(this.contextWindow / 2));
    this.estimator = options.estimator ?? new HeuristicTokenEstimator();
    if (options.compactor !== undefined) {
      this.compactor = options.compactor;
    }
    if (options.onCompaction !== undefined) {
      this.onCompaction = options.onCompaction;
    }
    if (this.reserveTokens >= this.contextWindow) {
      throw new TypeError("reserveTokens must be smaller than contextWindow.");
    }
  }

  get budget(): number {
    return this.contextWindow - this.reserveTokens;
  }

  async build(
    messages: readonly Message[],
    options: BuildOptions = {},
  ): Promise<BuiltContext> {
    const previous = options.previous;
    const summaryIndex = previous === undefined ? -1 : previous.anchorIndex === undefined ? 0 : 1;
    const effective = previous === undefined
      ? messages
      : previous.anchorIndex === undefined
        ? [summaryMessage(previous.state), ...messages.slice(previous.splitIndex)]
        : [messages[previous.anchorIndex]!, summaryMessage(previous.state), ...messages.slice(previous.splitIndex)];
    const prefixTokens = this.estimator.estimateMessages([...(options.prefixMessages ?? []), ...(options.fixedMessages ?? [])]);
    const estimatedTokens = this.estimator.estimateMessages(effective) + prefixTokens;

    if (prefixTokens > this.budget) {
      throw new ContextBudgetError(`System prompt and tool definitions need about ${prefixTokens} tokens, exceeding the available context budget of ${this.budget}.`);
    }

    if (estimatedTokens <= this.budget) {
      return {
        messages: effective,
        compacted: false,
        estimatedTokens,
        ...(previous === undefined ? {} : { compaction: previous }),
      };
    }

    if (this.compactor === undefined) {
      throw new ContextBudgetError(`The request needs about ${estimatedTokens} tokens, exceeding the available context budget of ${this.budget}; compaction is disabled.`);
    }

    let cut = findSplitIndex(effective, this.estimator, this.keepRecentTokens);
    const latestUser = findLastUserIndex(effective, summaryIndex);
    let anchored = latestUser >= 0 && cut > latestUser;
    // When the split lands immediately after the active user, that user is
    // still a safe anchor and older history before it can be compacted.
    const headStart = anchored ? latestUser : 0;
    if (cut <= headStart) {
      throw new ContextBudgetError(`The request needs about ${estimatedTokens} tokens, exceeding the available context budget of ${this.budget}; there is no safely removable history.`);
    }

    let head = (anchored ? effective.slice(0, cut) : effective.slice(headStart, cut))
      .filter((_message, index) => !anchored || index !== latestUser);
    let tail = effective.slice(cut);
    let { state, usage } = await this.compactor.compact(head, options.signal, previous?.state);
    let compactedMessages = anchored
      ? [effective[latestUser]!, summaryMessage(state), ...tail]
      : [summaryMessage(state), ...tail];
    let tokensAfter = this.estimator.estimateMessages(compactedMessages) + prefixTokens;

    // The configured recent-history target is only a starting point. Fixed
    // request context can consume enough budget that the target is too large.
    // Recompute the split once using the actual summary size, then summarise
    // the additional dropped history so it is not silently lost.
    if (tokensAfter > this.budget) {
      const summaryTokens = this.estimator.estimateMessage(summaryMessage(state));
      const anchorTokens = anchored ? this.estimator.estimateMessage(effective[latestUser]!) : 0;
      const tailBudget = this.budget - prefixTokens - summaryTokens - anchorTokens;
      if (tailBudget < 0) {
        throw new ContextBudgetError(`The request still needs about ${tokensAfter} tokens after compaction, exceeding the available context budget of ${this.budget}. Reduce the prompt, tool schemas, or context window reserve.`, usage);
      }

      const tighterCut = findSplitIndex(effective, this.estimator, tailBudget);
      const nextCut = Math.max(cut, tighterCut);
      if (nextCut === cut) {
        throw new ContextBudgetError(`The request still needs about ${tokensAfter} tokens after compaction, exceeding the available context budget of ${this.budget}. Reduce the prompt, tool schemas, or context window reserve.`, usage);
      }

      cut = nextCut;
      anchored = latestUser >= 0 && cut > latestUser;
      head = (anchored ? effective.slice(0, cut) : effective.slice(headStart, cut))
        .filter((_message, index) => !anchored || index !== latestUser);
      tail = effective.slice(cut);
      const second = await this.compactor.compact(head, options.signal, state);
      state = second.state;
      usage = mergeCompactionUsage(usage, second.usage);
      compactedMessages = anchored
        ? [effective[latestUser]!, summaryMessage(state), ...tail]
        : [summaryMessage(state), ...tail];
      tokensAfter = this.estimator.estimateMessages(compactedMessages) + prefixTokens;
      if (tokensAfter > this.budget) {
        throw new ContextBudgetError(`The request still needs about ${tokensAfter} tokens after compaction, exceeding the available context budget of ${this.budget}. Reduce the prompt, tool schemas, or context window reserve.`, usage);
      }
    }

    // Map the cut back onto the full transcript, allowing for the summary
    // message that the previous compaction injected at the front.
    const mapTranscriptIndex = (index: number): number => {
      if (previous === undefined) return index;
      if (previous.anchorIndex === undefined) return previous.splitIndex + Math.max(0, index - 1);
      if (index === 0) return previous.anchorIndex;
      return previous.splitIndex + Math.max(0, index - 2);
    };
    const splitIndex = mapTranscriptIndex(cut);
    const anchorIndex = anchored ? mapTranscriptIndex(latestUser) : undefined;

    this.onCompaction?.({
      droppedMessages: head.length,
      tokensBefore: estimatedTokens,
      tokensAfter,
      state,
    });

    return {
      messages: compactedMessages,
      compacted: true,
      estimatedTokens: tokensAfter,
      compaction: { state, splitIndex, ...(anchorIndex === undefined ? {} : { anchorIndex }) },
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

export class ContextBudgetError extends Error {
  constructor(message: string, readonly compactionUsage?: Usage) { super(message); this.name = "ContextBudgetError"; }
}

function mergeCompactionUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
  if (first === undefined || second === undefined) {
    // A partial usage report must remain visibly partial rather than pretending
    // that every compaction call was accounted for.
    return undefined;
  }
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    totalTokens: first.totalTokens + second.totalTokens,
    ...((first.cachedInputTokens !== undefined || second.cachedInputTokens !== undefined)
      ? { cachedInputTokens: (first.cachedInputTokens ?? 0) + (second.cachedInputTokens ?? 0) }
      : {}),
    ...((first.reasoningTokens !== undefined || second.reasoningTokens !== undefined)
      ? { reasoningTokens: (first.reasoningTokens ?? 0) + (second.reasoningTokens ?? 0) }
      : {}),
  };
}

function findLastUserIndex(messages: readonly Message[], syntheticSummaryIndex: number): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (index !== syntheticSummaryIndex && messages[index]?.role === "user") return index;
  }
  return -1;
}

function summaryMessage(state: CompactionState): Message {
  return { role: "user", content: renderCompactionState(state) };
}

/**
 * Chooses where recent history begins.
 *
 * Tool results immediately follow the assistant message that requested them,
 * so a split that lands on a tool result would orphan it. Moving forward past
 * the whole group keeps every tool call and its result on the same side.
 */
export function findSplitIndex(
  messages: readonly Message[],
  estimator: TokenEstimator,
  keepRecentTokens: number,
): number {
  let tokens = 0;
  let index = messages.length;
  while (index > 0) {
    const message = messages[index - 1];
    if (message === undefined) {
      break;
    }
    const cost = estimator.estimateMessage(message);
    if (tokens + cost > keepRecentTokens) {
      break;
    }
    tokens += cost;
    index -= 1;
  }

  while (index < messages.length && messages[index]?.role === "tool") {
    index += 1;
  }

  // Keep a real message after the summary for ordinary cuts.
  if (index >= messages.length) {
    index = messages.length - 1;
    while (index > 0 && messages[index]?.role === "tool") index -= 1;
  }

  return index;
}
