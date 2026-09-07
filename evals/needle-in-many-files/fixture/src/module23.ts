export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
}

/** Total time the client may spend retrying before it gives up. */
export function computeRetryBudget(options: RetryOptions): number {
  return options.attempts * options.baseDelayMs * 2;
}
