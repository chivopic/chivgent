import type { LLMClient, LLMRequest, LLMResponse } from "../src/llm.js";

export class FakeLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly LLMResponse[]) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error(`No fake LLM response configured for call ${this.index}.`);
    }
    this.index += 1;
    return structuredClone(response);
  }
}

export function assistant(
  content: string,
  toolCalls: LLMResponse["message"]["toolCalls"] = [],
  continuation?: unknown,
): LLMResponse {
  return {
    message: { role: "assistant", content, toolCalls },
    ...(continuation === undefined ? {} : { continuation }),
  };
}
