import { describe, expect, it, vi } from "vitest";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "../src/llm.js";
import { LLMTimeoutError, RetryingLLMClient } from "../src/retry.js";
import { assistant } from "./fakes.js";

const request: LLMRequest = {
  systemPrompt: "System prompt",
  messages: [{ role: "user", content: "Question" }],
  tools: [],
};

class ScriptedClient implements LLMClient {
  calls = 0;

  constructor(private readonly outcomes: readonly (LLMResponse | Error)[]) {}

  async complete(): Promise<LLMResponse> {
    const outcome = this.outcomes[this.calls];
    this.calls += 1;
    if (outcome === undefined) {
      throw new Error(`No outcome configured for call ${this.calls - 1}.`);
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function sleepSpy(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("RetryingLLMClient", () => {
  it("retries a retryable status code and returns the later success", async () => {
    const inner = new ScriptedClient([httpError(503), assistant("Done.")]);
    const { sleep, delays } = sleepSpy();
    const client = new RetryingLLMClient(inner, { sleep, initialDelayMs: 10 });

    const response = await client.complete(request);

    expect(response.message.content).toBe("Done.");
    expect(inner.calls).toBe(2);
    expect(delays).toEqual([10]);
  });

  it("backs off exponentially up to the cap", async () => {
    const inner = new ScriptedClient([
      httpError(429),
      httpError(429),
      httpError(429),
      assistant("Done."),
    ]);
    const { sleep, delays } = sleepSpy();
    const client = new RetryingLLMClient(inner, {
      sleep,
      initialDelayMs: 100,
      maxDelayMs: 150,
      maxAttempts: 4,
    });

    await client.complete(request);

    expect(delays).toEqual([100, 150, 150]);
  });

  it("does not retry a client error", async () => {
    const inner = new ScriptedClient([httpError(400), assistant("Done.")]);
    const client = new RetryingLLMClient(inner, { sleep: async () => {} });

    await expect(client.complete(request)).rejects.toThrow("HTTP 400");
    expect(inner.calls).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    const inner = new ScriptedClient([httpError(500), httpError(500)]);
    const client = new RetryingLLMClient(inner, {
      sleep: async () => {},
      maxAttempts: 2,
    });

    await expect(client.complete(request)).rejects.toThrow("HTTP 500");
    expect(inner.calls).toBe(2);
  });

  it("retries a network error", async () => {
    const inner = new ScriptedClient([
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      assistant("Done."),
    ]);
    const client = new RetryingLLMClient(inner, { sleep: async () => {} });

    await expect(client.complete(request)).resolves.toMatchObject({
      message: { content: "Done." },
    });
  });

  it("turns a stalled Provider call into a retryable timeout", async () => {
    const slow: LLMClient = {
      async complete(pendingRequest) {
        return new Promise((_resolve, reject) => {
          pendingRequest.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    };
    const client = new RetryingLLMClient(slow, {
      sleep: async () => {},
      requestTimeoutMs: 5,
      maxAttempts: 1,
    });

    await expect(client.complete(request)).rejects.toBeInstanceOf(
      LLMTimeoutError,
    );
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const inner: LLMClient = {
      async complete() {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const sleep = vi.fn(async () => {});
    const client = new RetryingLLMClient(inner, { sleep });

    await expect(
      client.complete({ ...request, signal: controller.signal }),
    ).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("exposes streaming only when the wrapped Provider streams", () => {
    const plain = new RetryingLLMClient(new ScriptedClient([]));
    const streaming = new RetryingLLMClient({
      async complete() {
        return assistant("Done.");
      },
      async stream() {
        return assistant("Done.");
      },
    });

    expect(plain.stream).toBeUndefined();
    expect(streaming.stream).toBeTypeOf("function");
  });

  it("retries a stream that fails before emitting text", async () => {
    let attempts = 0;
    const inner: LLMClient = {
      async complete() {
        throw new Error("unused");
      },
      async stream(_request: LLMRequest, handlers: LLMStreamHandlers) {
        attempts += 1;
        if (attempts === 1) {
          throw httpError(500);
        }
        handlers.onTextDelta("Done.");
        return assistant("Done.");
      },
    };
    const deltas: string[] = [];
    const client = new RetryingLLMClient(inner, { sleep: async () => {} });

    const response = await client.stream?.(request, {
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(response?.message.content).toBe("Done.");
    expect(deltas).toEqual(["Done."]);
  });

  it("never replays a stream that already emitted text", async () => {
    let attempts = 0;
    const inner: LLMClient = {
      async complete() {
        throw new Error("unused");
      },
      async stream(_request: LLMRequest, handlers: LLMStreamHandlers) {
        attempts += 1;
        handlers.onTextDelta("Partial");
        throw httpError(500);
      },
    };
    const client = new RetryingLLMClient(inner, { sleep: async () => {} });

    await expect(
      client.stream?.(request, { onTextDelta: () => {} }),
    ).rejects.toThrow("HTTP 500");
    expect(attempts).toBe(1);
  });
});
