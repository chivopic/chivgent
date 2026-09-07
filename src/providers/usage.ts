import type { Usage } from "../llm.js";

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Reads a Chat Completions `usage` object.
 *
 * Returns undefined rather than zeroes when the Provider reported nothing, so
 * a missing figure stays visibly missing all the way up to the total.
 */
export function fromChatCompletionsUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = positive(record.prompt_tokens);
  const outputTokens = positive(record.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  const details = record.completion_tokens_details as
    | Record<string, unknown>
    | undefined;
  const promptDetails = record.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const reasoningTokens = positive(details?.reasoning_tokens);
  const cachedInputTokens =
    positive(promptDetails?.cached_tokens) ??
    // DeepSeek reports cache hits at the top level rather than in details.
    positive(record.prompt_cache_hit_tokens);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens:
      positive(record.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** Reads a Responses API `usage` object, which names its fields differently. */
export function fromResponsesUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = positive(record.input_tokens);
  const outputTokens = positive(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  const outputDetails = record.output_tokens_details as
    | Record<string, unknown>
    | undefined;
  const inputDetails = record.input_tokens_details as
    | Record<string, unknown>
    | undefined;
  const reasoningTokens = positive(outputDetails?.reasoning_tokens);
  const cachedInputTokens = positive(inputDetails?.cached_tokens);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens:
      positive(record.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export interface UsageTotal {
  readonly usage: Usage;
  /**
   * False when at least one call reported nothing, so a reader can tell a
   * complete total from one that is missing a turn.
   */
  readonly complete: boolean;
}

export function addUsage(
  total: UsageTotal | undefined,
  next: Usage | undefined,
): UsageTotal {
  const base = total ?? {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    complete: true,
  };
  if (next === undefined) {
    return { usage: base.usage, complete: false };
  }

  const cached =
    (base.usage.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  const reasoning =
    (base.usage.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  return {
    usage: {
      inputTokens: base.usage.inputTokens + next.inputTokens,
      outputTokens: base.usage.outputTokens + next.outputTokens,
      totalTokens: base.usage.totalTokens + next.totalTokens,
      ...(cached === 0 ? {} : { cachedInputTokens: cached }),
      ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
    },
    complete: base.complete,
  };
}

/** Compact human form: 1234 -> "1.2k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
