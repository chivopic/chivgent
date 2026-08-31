import type { Message } from "./messages.js";
import type { ToolDefinition } from "./tools/tool.js";

/**
 * Characters per token for Latin-script text. Real tokenisers land near 4;
 * this deliberately does not try to be exact.
 */
const CHARACTERS_PER_TOKEN = 4;

/**
 * CJK and other wide scripts cost roughly one token per character, so they are
 * counted separately instead of being averaged away.
 */
const WIDE_SCRIPT_START = 0x2e80;

/** Per-message envelope (role, delimiters) charged by every Provider. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Per-tool envelope on top of the serialised schema. */
const TOOL_OVERHEAD_TOKENS = 8;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RequestShape {
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

/**
 * Estimates tokens without pulling in a tokeniser. It is intentionally a
 * heuristic and intentionally biased to over-count: compacting slightly early
 * is cheap, while a request that exceeds the real window fails outright with a
 * Provider error the user cannot act on.
 */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) >= WIDE_SCRIPT_START) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.ceil(narrow / CHARACTERS_PER_TOKEN) + wide;
}

export function estimateMessageTokens(message: Message): number {
  switch (message.role) {
    case "user":
      return MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);

    case "assistant": {
      const toolCallTokens = message.toolCalls.reduce(
        (total, toolCall) =>
          total +
          estimateTokens(toolCall.name) +
          estimateTokens(stringifyArguments(toolCall.arguments)),
        0,
      );
      return (
        MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content) + toolCallTokens
      );
    }

    case "tool":
      return (
        MESSAGE_OVERHEAD_TOKENS +
        estimateTokens(message.toolName) +
        estimateTokens(message.content)
      );
  }
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

export function estimateToolTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce(
    (total, tool) =>
      total +
      TOOL_OVERHEAD_TOKENS +
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.inputSchema)),
    0,
  );
}

/** Everything the Provider will be asked to read for one request. */
export function estimateRequestTokens(request: RequestShape): number {
  return (
    estimateTokens(request.systemPrompt) +
    estimateMessagesTokens(request.messages) +
    estimateToolTokens(request.tools)
  );
}

export function addUsage(
  left: TokenUsage,
  right: TokenUsage | undefined,
): TokenUsage {
  if (right === undefined) {
    return left;
  }
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
