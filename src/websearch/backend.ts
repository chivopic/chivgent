/**
 * Provider-independent web search contract.
 *
 * A backend is the only component that holds search credentials. The Agent and
 * the tool never see a key; the tool passes one approved query and receives
 * normalized, bounded results.
 */
export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** ISO-ish date reported by the search provider, when it reports one. */
  readonly publishedDate?: string;
}

export interface WebSearchResponse {
  /** Adapter and endpoint identity. It must never contain a credential. */
  readonly provider: string;
  readonly results: readonly WebSearchResult[];
}

export interface WebSearchBackend {
  readonly name: string;
  search(request: WebSearchRequest): Promise<WebSearchResponse>;
}

/** Bounds shared by the adapter and the tool. The tool re-applies them. */
export const WEB_SEARCH_LIMITS = {
  defaultResults: 5,
  maxResults: 10,
  queryCharacters: 256,
  titleCharacters: 200,
  snippetCharacters: 400,
  urlCharacters: 2_048,
  publishedDateCharacters: 64,
  providerCharacters: 100,
  responseBytes: 256 * 1024,
} as const;

export type WebSearchFailure =
  | "aborted"
  | "timeout"
  | "rate_limited"
  | "http"
  | "invalid_response"
  | "network";

/**
 * A safe, user-facing failure. Messages never include the endpoint, request
 * query, response body, or credentials.
 */
export class WebSearchBackendError extends Error {
  constructor(
    readonly kind: WebSearchFailure,
    message: string,
  ) {
    super(message);
    this.name = "WebSearchBackendError";
  }
}

export interface SearxngBackendOptions {
  /** Base URL of the SearXNG instance, for example https://search.example.com. */
  readonly baseURL: string;
  /** Optional bearer token; supplied through the environment, never argv. */
  readonly token?: string;
  /** Injectable transport for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * SearXNG's JSON search API (the instance must allow `format=json`).
 *
 * The adapter is deliberately small: one GET request, no retries, no cookies,
 * no redirects, and a bounded response body. Adding another backend means
 * implementing WebSearchBackend, not changing the Agent or the tool.
 */
export class SearxngBackend implements WebSearchBackend {
  readonly name: string;
  private readonly searchURL: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SearxngBackendOptions) {
    const url = parseBackendURL(options.baseURL);
    const path = url.pathname.replace(/\/+$/, "");
    this.searchURL = path.endsWith("/search")
      ? `${url.origin}${path}`
      : `${url.origin}${path}/search`;
    this.name = `searxng (${url.host})`;
    if (options.token !== undefined && options.token.length > 0) {
      this.token = options.token;
    }
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new TypeError("Web search timeout must be a positive integer.");
    }
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
    const url = new URL(this.searchURL);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
        },
        redirect: "error",
        signal,
      });
    } catch {
      if (request.signal?.aborted) {
        throw new WebSearchBackendError("aborted", "the search was cancelled");
      }
      if (timeout.aborted) {
        throw new WebSearchBackendError(
          "timeout",
          `the search provider did not respond within ${Math.ceil(this.timeoutMs / 1_000)} seconds`,
        );
      }
      throw new WebSearchBackendError("network", "could not reach the search provider");
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new WebSearchBackendError(
          "rate_limited",
          "the search provider rate-limited the request (HTTP 429)",
        );
      }
      throw new WebSearchBackendError(
        "http",
        `the search provider returned HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedBody(response));
    } catch (error: unknown) {
      if (error instanceof WebSearchBackendError) throw error;
      throw new WebSearchBackendError(
        "invalid_response",
        "the search provider returned an invalid response",
      );
    }
    const rawResults = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).results
      : undefined;
    if (!Array.isArray(rawResults)) {
      throw new WebSearchBackendError(
        "invalid_response",
        "the search provider returned an invalid response",
      );
    }

    return {
      provider: this.name,
      results: normalizeSearxngResults(rawResults, request.maxResults),
    };
  }
}

/** Human-readable adapter identity without credentials or URL path. */
export function webSearchProviderName(baseURL: string): string {
  return `searxng (${parseBackendURL(baseURL).host})`;
}

/** Validates and normalizes a user-supplied backend URL. */
export function parseBackendURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Web search URL must be an absolute http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Web search URL must use http or https.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("Web search URL must not contain credentials; use CHIVGENT_WEB_SEARCH_TOKEN.");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError("Web search URL must not contain a query string or fragment.");
  }
  return url;
}

/** Applies the output bounds to results supplied by any backend. */
export function boundWebSearchResults(
  results: readonly unknown[],
  maxResults: number,
): readonly WebSearchResult[] {
  const bounded: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const value of results) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const url = normalizeResultURL(record.url);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const publishedDate = boundText(
      record.publishedDate ?? record.published_date,
      WEB_SEARCH_LIMITS.publishedDateCharacters,
    );
    bounded.push({
      title: boundText(record.title, WEB_SEARCH_LIMITS.titleCharacters) || url,
      url,
      snippet: boundText(record.snippet ?? record.content, WEB_SEARCH_LIMITS.snippetCharacters),
      ...(publishedDate.length === 0 ? {} : { publishedDate }),
    });
    if (bounded.length >= maxResults) break;
  }
  return bounded;
}

/** Collapses whitespace and control characters, then bounds by characters. */
export function boundText(value: unknown, maxCharacters: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...clean];
  return characters.length <= maxCharacters
    ? clean
    : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function normalizeSearxngResults(
  raw: readonly unknown[],
  maxResults: number,
): readonly WebSearchResult[] {
  const mapped = raw.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return {
      title: record.title,
      url: record.url,
      snippet: record.content ?? record.snippet,
      publishedDate: record.publishedDate ?? record.published_date,
    };
  });
  return boundWebSearchResults(mapped, maxResults);
}

function normalizeResultURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > WEB_SEARCH_LIMITS.urlCharacters) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  return url.toString();
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaration = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaration) && declaration > WEB_SEARCH_LIMITS.responseBytes) {
    throw new WebSearchBackendError(
      "invalid_response",
      "the search provider response was too large",
    );
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WEB_SEARCH_LIMITS.responseBytes) {
        throw new WebSearchBackendError(
          "invalid_response",
          "the search provider response was too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}
