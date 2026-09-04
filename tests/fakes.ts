import { WorkspaceError } from "../src/workspace.js";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "../src/llm.js";

export class FakeLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly LLMResponse[]) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return structuredClone(this.take(request));
  }

  protected take(request: LLMRequest): LLMResponse {
    this.requests.push(cloneRequest(request));
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error(`No fake LLM response configured for call ${this.index}.`);
    }
    this.index += 1;
    return response;
  }
}

/**
 * Emits one delta per configured chunk before resolving with the same response
 * a non-streaming Provider would return.
 */
export class FakeStreamingLLMClient extends FakeLLMClient {
  private streamedCalls = 0;

  constructor(
    responses: readonly LLMResponse[],
    private readonly deltas: ReadonlyMap<number, readonly string[]> = new Map(),
  ) {
    super(responses);
  }

  async stream(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const response = this.take(request);
    const call = this.streamedCalls;
    this.streamedCalls += 1;

    for (const delta of this.deltas.get(call) ??
      splitDeltas(response.message.content)) {
      handlers.onTextDelta(delta);
    }
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

function splitDeltas(content: string): readonly string[] {
  return content.length === 0 ? [] : [content];
}

function cloneRequest(request: LLMRequest): LLMRequest {
  const { signal, ...rest } = request;
  return structuredClone(rest);
}

/**
 * Write methods for read-only Workspace fakes. Spread into a fake to satisfy
 * the contract without pretending the fake can persist anything.
 */
export const readOnlyWorkspaceWrites = {
  async writeTextFile(): Promise<never> {
    throw new WorkspaceError("writes_disabled", "This fake is read-only.");
  },
  async editTextFile(): Promise<never> {
    throw new WorkspaceError("writes_disabled", "This fake is read-only.");
  },
};
