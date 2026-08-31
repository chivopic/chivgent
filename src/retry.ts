import {
  isAbortError,
  LLMAbortError,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamHandlers,
} from "./llm.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class LLMTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The Provider call exceeded ${timeoutMs}ms.`);
    this.name = "LLMTimeoutError";
  }
}

export interface RetryOptions {
  /** Total attempts, including the first one. Defaults to 3. */
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Per-attempt deadline. Use 0 to disable. Defaults to 120000. */
  readonly requestTimeoutMs?: number;
  /** Injected so tests do not depend on wall-clock time. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onRetry?: (info: RetryAttempt) => void;
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * Wraps a Provider with per-attempt timeouts and bounded exponential backoff.
 * Retries stay invisible to the Agent Loop: it still sees one call that either
 * resolves with an assistant message or fails.
 */
export class RetryingLLMClient implements LLMClient {
  readonly stream?: (
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ) => Promise<LLMResponse>;

  private readonly inner: LLMClient;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onRetry: ((info: RetryAttempt) => void) | undefined;

  constructor(inner: LLMClient, options: RetryOptions = {}) {
    this.inner = inner;
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRetry = options.onRetry;

    if (inner.stream !== undefined) {
      this.stream = (request, handlers) => this.runStream(request, handlers);
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.withRetries(request, (attemptRequest) =>
      this.inner.complete(attemptRequest),
    );
  }

  private async runStream(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const stream = this.inner.stream;
    if (stream === undefined) {
      throw new TypeError("The wrapped Provider does not support streaming.");
    }

    return this.withRetries(request, async (attemptRequest, markCommitted) =>
      stream.call(this.inner, attemptRequest, {
        onTextDelta: (delta) => {
          // Text already shown to the user cannot be replayed by a retry.
          markCommitted();
          handlers.onTextDelta(delta);
        },
      }),
    );
  }

  private async withRetries(
    request: LLMRequest,
    call: (
      request: LLMRequest,
      markCommitted: () => void,
    ) => Promise<LLMResponse>,
  ): Promise<LLMResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfAborted(request.signal);
      const deadline = this.createDeadline(request.signal);
      let committed = false;

      try {
        return await call({ ...request, signal: deadline.signal }, () => {
          committed = true;
        });
      } catch (error: unknown) {
        lastError = deadline.timedOut ? new LLMTimeoutError(this.requestTimeoutMs) : error;
        throwIfAborted(request.signal);
        if (isAbortError(error) && !deadline.timedOut) {
          throw error;
        }
        if (committed || attempt === this.maxAttempts || !isRetryable(lastError)) {
          throw lastError;
        }
        const delayMs = this.backoffDelay(attempt);
        this.onRetry?.({
          attempt,
          delayMs,
          reason: describeError(lastError),
        });
        await this.sleep(delayMs, request.signal);
      } finally {
        deadline.dispose();
      }
    }

    throw lastError ?? new Error("The Provider call failed.");
  }

  private backoffDelay(attempt: number): number {
    const exponential = this.initialDelayMs * 2 ** (attempt - 1);
    return Math.min(this.maxDelayMs, exponential);
  }

  private createDeadline(signal: AbortSignal | undefined): Deadline {
    const controller = new AbortController();
    const state = { timedOut: false };
    const forward = () => {
      controller.abort(signal?.reason);
    };

    if (signal !== undefined) {
      if (signal.aborted) {
        forward();
      } else {
        signal.addEventListener("abort", forward, { once: true });
      }
    }

    const timer =
      this.requestTimeoutMs > 0
        ? setTimeout(() => {
            state.timedOut = true;
            controller.abort(new LLMTimeoutError(this.requestTimeoutMs));
          }, this.requestTimeoutMs)
        : undefined;
    timer?.unref?.();

    return {
      signal: controller.signal,
      get timedOut() {
        return state.timedOut;
      },
      dispose() {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", forward);
      },
    };
  }
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LLMTimeoutError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("status" in error && typeof error.status === "number") {
    return (
      RETRYABLE_STATUS_CODES.has(error.status) ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  if ("code" in error && typeof error.code === "string") {
    return RETRYABLE_ERROR_CODES.has(error.code);
  }
  return (
    "name" in error &&
    (error.name === "APIConnectionError" ||
      error.name === "APIConnectionTimeoutError")
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return "Unknown Provider error";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new LLMAbortError();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LLMAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
