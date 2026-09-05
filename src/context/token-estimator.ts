import type { Message } from "../messages.js";

export interface TokenEstimator {
  estimateMessage(message: Message): number;
  estimateMessages(messages: readonly Message[]): number;
}

/**
 * Approximates token counts from character length.
 *
 * A real tokenizer is Provider- and model-specific and would pull in a large
 * dependency for a number that only decides *when* to compact. The reserve
 * budget exists to absorb this estimate's error: overshooting compacts a
 * little early, which costs a summary call rather than a failed request.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  constructor(
    private readonly charactersPerToken = 4,
    private readonly messageOverheadTokens = 4,
  ) {
    if (charactersPerToken <= 0) {
      throw new TypeError("charactersPerToken must be positive.");
    }
  }

  estimateMessage(message: Message): number {
    return (
      this.messageOverheadTokens +
      Math.ceil(this.textOf(message).length / this.charactersPerToken)
    );
  }

  estimateMessages(messages: readonly Message[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateMessage(message);
    }
    return total;
  }

  private textOf(message: Message): string {
    if (message.role === "assistant") {
      const calls = message.toolCalls
        .map((call) => `${call.name}${JSON.stringify(call.arguments)}`)
        .join("");
      return `${message.content}${calls}`;
    }
    if (message.role === "tool") {
      return `${message.toolName}${message.content}`;
    }
    return message.content;
  }
}
