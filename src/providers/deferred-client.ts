import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "../llm.js";

export class NotSignedInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSignedInError";
  }
}

/**
 * An LLMClient whose Provider can arrive later.
 *
 * Credentials used to be a gate before the session existed, so a user without a
 * key was told what was missing and dropped back to the shell — with no way to
 * fix it from inside chivgent. Wrapping the client lets the session start
 * regardless and `/login` fill it in, and lets a later `/login` replace a key
 * that turned out to be wrong.
 */
export class DeferredLLMClient implements LLMClient {
  private client: LLMClient | undefined;

  constructor(private readonly missingMessage: string) {}

  get ready(): boolean {
    return this.client !== undefined;
  }

  /** The message explaining what is missing, for callers that ask first. */
  get guidance(): string {
    return this.missingMessage;
  }

  set(client: LLMClient): void {
    this.client = client;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.require().complete(request);
  }

  async stream(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const client = this.require();
    // Streaming stays optional on the wrapped client; the Agent must not have
    // to know which kind it got.
    return client.stream === undefined
      ? client.complete(request)
      : client.stream(request, handlers);
  }

  private require(): LLMClient {
    if (this.client === undefined) {
      throw new NotSignedInError(this.missingMessage);
    }
    return this.client;
  }
}
