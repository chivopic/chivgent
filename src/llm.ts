import type { AssistantMessage, Message } from "./messages.js";
import type { ToolDefinition } from "./tools/tool.js";

/**
 * Opaque provider-owned state needed to continue a tool-calling turn.
 * The Agent stores and returns it without inspecting its contents.
 */
export type LLMContinuation = unknown;

export interface LLMRequest {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly continuation?: LLMContinuation;
  /** Cancels the in-flight provider call. */
  readonly signal?: AbortSignal;
}

/**
 * What one Provider call cost, as the Provider itself reported it.
 *
 * Tokens only, never money: a model-to-price table goes stale silently when a
 * Provider changes its rates, and a confidently wrong dollar figure is worse
 * than none, because nobody questions a number with a decimal point in it.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** The cached share of the input, when the Provider reports one. */
  readonly cachedInputTokens?: number;
  /** Thinking tokens billed separately by reasoning models. */
  readonly reasoningTokens?: number;
}

export interface LLMResponse {
  readonly message: AssistantMessage;
  readonly continuation?: LLMContinuation;
  /**
   * Absent when the Provider did not report it, which is a normal state and
   * never an error. Treating "not reported" as zero would quietly understate
   * every total that contains it.
   */
  readonly usage?: Usage;
}

export interface LLMStreamHandlers {
  /** Called with assistant text as it arrives, never with the full snapshot. */
  readonly onTextDelta: (delta: string) => void;
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
  /**
   * Optional streaming variant. It must resolve to the same
   * {@link LLMResponse} that `complete` would return for the same request, so
   * the Agent Loop never branches on whether a Provider streams.
   */
  stream?(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse>;
}

/** Thrown when a Provider call is cancelled through its {@link AbortSignal}. */
export class LLMAbortError extends Error {
  constructor(message = "The Provider call was aborted.") {
    super(message);
    this.name = "LLMAbortError";
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof LLMAbortError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}
