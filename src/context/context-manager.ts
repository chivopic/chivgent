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
  /** False when at least one compaction Provider call omitted usage. */
  readonly usageComplete?: boolean;
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

    const buildHeadAndTail = (split: number, anchor: boolean): {
      readonly head: readonly Message[];
      readonly tail: readonly Message[];
    } => {
      // An anchored checkpoint has the shape [anchor, summary, suffix].
      // If the next cut lands immediately after the anchor, compact the old
      // synthetic summary itself so it is carried into the replacement state.
      if (anchor && previous?.anchorIndex !== undefined && split === 1) {
        return {
          head: [effective[1]!],
          tail: effective.slice(2),
        };
      }
      const head = (anchor ? effective.slice(0, split) : effective.slice(0, split))
        .filter((_message, index) => !anchor || index !== latestUser);
      return { head, tail: effective.slice(split) };
    };

    let { head, tail } = buildHeadAndTail(cut, anchored);
    // Never spend a summarizer call when there is no real history to remove.
    // This is the case for a first compaction where the active user is the
    // only message before the retained tool exchange.
    if (head.length === 0) {
      throw new ContextBudgetError(`The request needs about ${estimatedTokens} tokens, exceeding the available context budget of ${this.budget}; there is no safely removable history.`);
    }

    let state: CompactionState;
    let usage: Usage | undefined;
    const first = await this.compactor.compact(head, options.signal, previous?.state);
    state = first.state;
    usage = first.usage;
    let compactedMessages = anchored
      ? [effective[latestUser]!, summaryMessage(state), ...tail]
      : [summaryMessage(state), ...tail];
    let tokensAfter = this.estimator.estimateMessages(compactedMessages) + prefixTokens;

    // The configured recent-history target is only a starting point. Fixed
    // request context can consume enough budget that the target is too large.
    // Recompute the split once using the actual summary size, then compact the
    // additional history into the replacement summary.
    if (tokensAfter > this.budget) {
      const summaryTokens = this.estimator.estimateMessage(summaryMessage(state));
      const anchorTokens = anchored ? this.estimator.estimateMessage(effective[latestUser]!) : 0;
      const tailBudget = this.budget - prefixTokens - summaryTokens - anchorTokens;
      if (tailBudget < 0) {
        throw new ContextBudgetError(`The request still needs about ${tokensAfter} tokens after compaction, exceeding the available context budget of ${this.budget}. Reduce the prompt, tool schemas, or context window reserve.`, usage);
      }

      const initialCut = cut;
      cut = findSplitIndexForTailBudget(effective, this.estimator, initialCut, tailBudget);
      anchored = latestUser >= 0 && cut > latestUser;
      ({ head, tail } = buildHeadAndTail(cut, anchored));
      if (head.length === 0) {
        throw new ContextBudgetError(`The request still needs about ${tokensAfter} tokens after compaction, exceeding the available context budget of ${this.budget}. Reduce the prompt, tool schemas, or context window reserve.`, usage);
      }

      const second = await this.compactor.compact(head, options.signal, state);
      state = second.state;
      usage = mergeCompactionUsage(usage, second.usage);
      compactedMessages = anchored
        ? [effective[latestUser]!, summaryMessage(state), ...tail]
        : [summaryMessage(state), ...tail];
      tokensAfter = this.estimator.estimateMessages(compactedMessages) + prefixTokens;
      if (tokensAfter > this.budget) {
        // A single retry is deliberately bounded. The new summary can itself
        // grow, so another retry would multiply Provider calls unpredictably.
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
      usageComplete: usage !== undefined,
    };
  }
}

export class ContextBudgetError extends Error {
  constructor(message: string, readonly compactionUsage?: Usage) { super(message); this.name = "ContextBudgetError"; }
}

function mergeCompactionUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
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

function findSplitIndexForTailBudget(
  messages: readonly Message[],
  estimator: TokenEstimator,
  minimumCut: number,
  maxTailTokens: number,
): number {
  return Math.max(
    minimumCut,
    findSplitIndex(messages, estimator, maxTailTokens),
  );
}

function findLastUserIndex(messages: readonly Message[], syntheticSummaryIndex: number) {
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
    const start = toolGroupStart(messages, index);
    const cost = estimator.estimateMessages(messages.slice(start, index));
    if (tokens + cost > keepRecentTokens) {
      break;
    }
    tokens += cost;
    index = start;
  }

  // Keep at least one real message after the summary. If the final tool
  // exchange is itself larger than the target, keep the whole exchange rather
  // than splitting its assistant call from its result. The ContextManager can
  // then reject it if the active exchange cannot fit at all.
  if (index >= messages.length) {
    index = toolGroupStart(messages, messages.length);
    if (index <= 0) {
      index = Math.max(0, messages.length - 1);
    }
  }

  return index;
}

function toolGroupStart(messages: readonly Message[], endExclusive: number): number {
  let start = endExclusive;
  while (start > 0 && messages[start - 1]?.role === "tool") {
    start -= 1;
  }

  const assistant = messages[start - 1];
  if (assistant?.role === "assistant" && assistant.toolCalls.length > 0) {
    return start - 1;
  }
  return start;
}
