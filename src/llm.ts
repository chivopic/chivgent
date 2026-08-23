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
}

export interface LLMResponse {
  readonly message: AssistantMessage;
  readonly continuation?: LLMContinuation;
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
