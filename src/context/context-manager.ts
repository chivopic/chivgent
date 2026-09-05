import type { Message } from "../messages.js";
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
}

export interface BuildOptions {
  /** The compaction already in force, so it is not recomputed every turn. */
  readonly previous?: AppliedCompaction;
  readonly signal?: AbortSignal;
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
    const effective =
      previous === undefined
        ? messages
        : [summaryMessage(previous.state), ...messages.slice(previous.splitIndex)];
    const estimatedTokens = this.estimator.estimateMessages(effective);

    if (this.compactor === undefined || estimatedTokens <= this.budget) {
      return {
        messages: effective,
        compacted: false,
        estimatedTokens,
        ...(previous === undefined ? {} : { compaction: previous }),
      };
    }

    const cut = findSplitIndex(effective, this.estimator, this.keepRecentTokens);
    // A cut of zero leaves nothing to summarise; with a previous compaction the
    // cut must also clear the injected summary for progress to be made.
    if (cut <= 0 || (previous !== undefined && cut < 1)) {
      return {
        messages: effective,
        compacted: false,
        estimatedTokens,
        ...(previous === undefined ? {} : { compaction: previous }),
      };
    }

    const head = effective.slice(0, cut);
    const tail = effective.slice(cut);
    const state = await this.compactor.compact(head, options.signal);
    const compactedMessages = [summaryMessage(state), ...tail];
    const tokensAfter = this.estimator.estimateMessages(compactedMessages);

    // Map the cut back onto the full transcript, allowing for the summary
    // message that the previous compaction injected at the front.
    const splitIndex =
      previous === undefined
        ? cut
        : previous.splitIndex + (cut - 1);

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
      compaction: { state, splitIndex },
    };
  }
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

  // Always leave at least one real message after the summary.
  if (index >= messages.length) {
    index = messages.length - 1;
    while (index > 0 && messages[index]?.role === "tool") {
      index -= 1;
    }
  }
  return index;
}
