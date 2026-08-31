import type { AssistantMessage, Message } from "./messages.js";
import type { TokenUsage } from "./tokens.js";
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

export interface LLMResponse {
  readonly message: AssistantMessage;
  readonly continuation?: LLMContinuation;
  /** Reported by the Provider when it returns usage; never estimated here. */
  readonly usage?: TokenUsage;
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
