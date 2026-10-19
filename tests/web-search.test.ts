import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentOptions } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { WebSearchTool } from "../src/tools/web-search.js";
import { LocalWorkspace } from "../src/workspace.js";
import {
  boundWebSearchResults,
  SearxngBackend,
  WebSearchBackendError,
  type WebSearchBackend,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from "../src/websearch/backend.js";
import { assistant, FakeLLMClient } from "./fakes.js";

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

// Node.js 22 provides Promise.withResolvers; this project's ES2022 lib does
// not declare it. The cast is named here and used only for that method.
const promiseApi = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};

interface RunningServer {
  readonly baseURL: string;
  readonly close: () => Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<RunningServer> {
  const server = createServer(handler);
  const listening = promiseApi.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Test server did not bind a TCP address.");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      const closed = promiseApi.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

class FakeSearchBackend implements WebSearchBackend {
  readonly calls: WebSearchRequest[] = [];
  readonly name = "fake (test)";

  constructor(private readonly response: WebSearchResponse) {}

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    this.calls.push(request);
    return this.response;
  }
}

describe("SearxngBackend", () => {
  it("sends one approved query and normalizes bounded SearXNG results", async () => {
    let seenURL: URL | undefined;
    let seenAuthorization: string | undefined;
    const server = await startServer((request, response) => {
      seenURL = new URL(request.url ?? "/", "http://127.0.0.1");
      const authorization = request.headers.authorization;
      seenAuthorization = typeof authorization === "string" ? authorization : undefined;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        results: [
          {
            title: "Node.js 22 release",
            url: "https://nodejs.org/en/blog/release/v22.0.0",
            content: "Node.js 22\nships   with new features",
            publishedDate: "2024-04-24T00:00:00",
          },
          { title: "Dropped FTP", url: "ftp://example.com/file", content: "no" },
          { title: "Duplicate", url: "https://nodejs.org/en/blog/release/v22.0.0", content: "same" },
          { title: "", url: "https://example.com/second", content: "second" },
        ],
      }));
    });
    try {
      const backend = new SearxngBackend({ baseURL: server.baseURL, token: "search-secret" });
      const result = await backend.search({ query: "node 22 release", maxResults: 5 });

      expect(seenURL?.pathname).toBe("/search");
      expect(seenURL?.searchParams.get("q")).toBe("node 22 release");
      expect(seenURL?.searchParams.get("format")).toBe("json");
      expect(seenAuthorization).toBe("Bearer search-secret");
      expect(result.provider).toBe(`searxng (127.0.0.1:${new URL(server.baseURL).port})`);
      expect(result.results).toEqual([
        {
          title: "Node.js 22 release",
          url: "https://nodejs.org/en/blog/release/v22.0.0",
          snippet: "Node.js 22 ships with new features",
          publishedDate: "2024-04-24T00:00:00",
        },
        {
          title: "https://example.com/second",
          url: "https://example.com/second",
          snippet: "second",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("reports a timeout without retrying or exposing endpoint details", async () => {
    const server = await startServer(() => undefined);
    try {
      const backend = new SearxngBackend({ baseURL: server.baseURL, timeoutMs: 40 });
      await expect(backend.search({ query: "slow", maxResults: 1 })).rejects.toMatchObject({
        kind: "timeout",
        message: expect.stringContaining("did not respond"),
      });
    } finally {
      await server.close();
    }
  });

  it("maps HTTP 429 and other statuses to safe errors", async () => {
    let status = 429;
    const server = await startServer((_request, response) => {
      response.writeHead(status);
      response.end("body that must not be echoed");
    });
    try {
      const backend = new SearxngBackend({ baseURL: server.baseURL });
      await expect(backend.search({ query: "q", maxResults: 1 })).rejects.toMatchObject({
        kind: "rate_limited",
        message: "the search provider rate-limited the request (HTTP 429)",
      });
      status = 500;
      await expect(backend.search({ query: "q", maxResults: 1 })).rejects.toMatchObject({
        kind: "http",
        message: "the search provider returned HTTP 500",
      });
    } finally {
      await server.close();
    }
  });

  it("does not follow redirects and validates the configured URL", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: "https://example.com/elsewhere" });
      response.end();
    });
    try {
      const backend = new SearxngBackend({ baseURL: server.baseURL });
      await expect(backend.search({ query: "q", maxResults: 1 })).rejects.toMatchObject({
        kind: "network",
      });
    } finally {
      await server.close();
    }
    expect(() => new SearxngBackend({ baseURL: "file:///etc/passwd" })).toThrow(/http or https/);
    expect(() => new SearxngBackend({ baseURL: "https://user:pass@search.example" })).toThrow(/credentials/);
  });
});

describe("boundWebSearchResults", () => {
  it("drops invalid entries, de-duplicates URLs and applies field bounds", () => {
    const results = boundWebSearchResults([
      { title: "a".repeat(500), url: "https://example.com/1", snippet: "b".repeat(900), publishedDate: "c".repeat(200) },
      { title: "duplicate", url: "https://example.com/1", snippet: "dup" },
      { title: "bad", url: "javascript:alert(1)", snippet: "x" },
      { title: "auth", url: "https://user:pass@example.com/2", snippet: "x" },
      { title: "second", url: "https://example.com/2", snippet: "ok" },
    ], 10);

    expect(results).toHaveLength(2);
    const [first, second] = results;
    expect([...(first?.title ?? "")].length).toBeLessThanOrEqual(200);
    expect([...(first?.snippet ?? "")].length).toBeLessThanOrEqual(400);
    expect([...(first?.publishedDate ?? "")].length).toBeLessThanOrEqual(64);
    expect(second?.url).toBe("https://example.com/2");
  });
});

describe("WebSearchTool", () => {
  const workspace = new LocalWorkspace(process.cwd());

  function response(results: readonly WebSearchResult[], provider = "fake (test)"): WebSearchResponse {
    return { provider, results };
  }

  it("returns provider-attributed structured results and re-applies output bounds", async () => {
    const many: WebSearchResult[] = Array.from({ length: 30 }, (_, index) => ({
      title: `${index} ${"t".repeat(2_000)}`,
      url: `https://example.com/${index}`,
      snippet: "s".repeat(5_000),
      publishedDate: "2026-01-01",
    }));
    const backend = new FakeSearchBackend(response(many));
    const tool = new WebSearchTool({ backend });
    const output = await tool.execute({ query: "release notes", max_results: 10 }, { workspace });

    expect(output.isError).toBe(false);
    expect(output.content.split("\n")[0]).toContain("fake (test)");
    expect(output.content).toContain("untrusted");
    const resultLines = output.content.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(resultLines).toHaveLength(10);
    const first = JSON.parse(resultLines[0]!.replace(/^1\. /, "")) as { title: string; snippet: string };
    expect([...first.title].length).toBeLessThanOrEqual(200);
    expect([...first.snippet].length).toBeLessThanOrEqual(400);
    expect(output.content.length).toBeLessThan(64 * 1024);
  });

  it("requests nothing and returns a clear error when consent is declined", async () => {
    const backend = new FakeSearchBackend(response([]));
    const authorize = vi.fn(async () => false);
    const tool = new WebSearchTool({ backend, authorize });
    const output = await tool.execute({ query: "private token", max_results: 2 }, { workspace });

    expect(output.isError).toBe(true);
    expect(output.content).toContain("denied");
    expect(output.content).toContain("No request was sent");
    expect(authorize).toHaveBeenCalledWith("private token", undefined);
    expect(backend.calls).toEqual([]);
  });

  it("honours cancellation and never returns a result after abort", async () => {
    const startedSignal = promiseApi.withResolvers<void>();
    const backend: WebSearchBackend = {
      name: "fake (test)",
      search: (request) => {
        const pending = promiseApi.withResolvers<WebSearchResponse>();
        startedSignal.resolve();
        request.signal?.addEventListener("abort", () => {
          pending.reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
        return pending.promise;
      },
    };
    const tool = new WebSearchTool({ backend });
    const controller = new AbortController();
    const pending = tool.execute({ query: "cancel me" }, { workspace, signal: controller.signal });
    await startedSignal.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps backend timeout and rate-limit failures to bounded tool errors", async () => {
    const timeout = new WebSearchTool({
      backend: { name: "fake (test)", search: async () => { throw new WebSearchBackendError("timeout", "the search provider did not respond within 10 seconds"); } },
    });
    await expect(timeout.execute({ query: "slow" }, { workspace })).resolves.toMatchObject({
      isError: true,
      content: "Web search failed: the search provider did not respond within 10 seconds.",
    });

    const limited = new WebSearchTool({
      backend: { name: "fake (test)", search: async () => { throw new WebSearchBackendError("rate_limited", "the search provider rate-limited the request (HTTP 429)"); } },
    });
    await expect(limited.execute({ query: "busy" }, { workspace })).resolves.toMatchObject({
      isError: true,
      content: "Web search failed: the search provider rate-limited the request (HTTP 429).",
    });
  });

  it("enforces a per-session request ceiling before reaching the backend", async () => {
    let now = 0;
    const backend = new FakeSearchBackend(response([]));
    const tool = new WebSearchTool({ backend, now: () => now });
    for (let index = 0; index < 10; index += 1) {
      await expect(tool.execute({ query: `q${index}` }, { workspace })).resolves.toMatchObject({ isError: false });
    }
    await expect(tool.execute({ query: "eleven" }, { workspace })).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("rate limit"),
    });
    expect(backend.calls).toHaveLength(10);
    now = 60_001;
    await expect(tool.execute({ query: "later" }, { workspace })).resolves.toMatchObject({ isError: false });
    expect(backend.calls).toHaveLength(11);
  });

  it("rejects malformed arguments and malformed backend responses", async () => {
    const backend = new FakeSearchBackend(response([]));
    const tool = new WebSearchTool({ backend });
    for (const argumentsValue of [
      {},
      { query: "" },
      { query: "a".repeat(257) },
      { query: "ok", max_results: 11 },
      { query: "ok", extra: true },
    ]) {
      await expect(tool.execute(argumentsValue, { workspace })).resolves.toMatchObject({ isError: true });
    }
    expect(backend.calls).toEqual([]);

    const malformed = new WebSearchTool({
      backend: { name: "fake", search: async () => ({ provider: "fake" } as unknown as WebSearchResponse) },
    });
    await expect(malformed.execute({ query: "ok" }, { workspace })).resolves.toMatchObject({
      isError: true,
      content: "Web search failed: the search provider returned an invalid response.",
    });
  });
});

describe("Agent integration", () => {
  const workspace = new LocalWorkspace(process.cwd());

  it("completes a grounded tool call and reports it through the event stream", async () => {
    const backend = new FakeSearchBackend({
      provider: "fake (test)",
      results: [{
        title: "Node.js 24 release",
        url: "https://nodejs.org/en/blog/release/v24.0.0",
        snippet: "Node.js 24 is the current release.",
        publishedDate: "2025-05-06",
      }],
    });
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [{ id: "search-1", name: "web_search", arguments: { query: "node 24 release", max_results: 2 } }]),
      assistant("Node.js 24 is current, per nodejs.org."),
    ]);
    const options: AgentOptions = {
      systemPrompt: "test",
      maxTurns: 3,
      llm,
      tools: [new WebSearchTool({ backend })],
      workspace,
      streaming: false,
      onEvent: (event) => events.push(event),
    };
    const result = await new Agent(options).run("What is current?");

    expect(result.status).toBe("completed");
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.query).toBe("node 24 release");
    const start = events.find((event) => event.type === "tool_execution_start");
    expect(start).toMatchObject({
      toolName: "web_search",
      arguments: { query: "node 24 release", max_results: 2 },
    });
    const end = events.find((event) => event.type === "tool_execution_end");
    expect(end).toMatchObject({ toolName: "web_search", isError: false });
    if (end?.type !== "tool_execution_end") throw new Error("missing tool execution end");
    expect(end.content).toContain("https://nodejs.org/en/blog/release/v24.0.0");
    expect(end.content).toContain("fake (test)");
  });

  it("cannot be bypassed by an Agent-level tool authorization", async () => {
    const backend = new FakeSearchBackend({ provider: "fake (test)", results: [] });
    const llm = new FakeLLMClient([
      assistant("", [{ id: "search-1", name: "web_search", arguments: { query: "bypass" } }]),
      assistant("Denied."),
    ]);
    const session = new Agent({
      systemPrompt: "test",
      maxTurns: 3,
      llm,
      tools: [new WebSearchTool({ backend, authorize: async () => false })],
      workspace,
      streaming: false,
      authorizeToolCall: async () => true,
    });
    const result = await session.run("Search anyway");
    expect(result.status).toBe("completed");
    expect(backend.calls).toEqual([]);
    const toolResult = result.messages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ isError: true, content: expect.stringContaining("denied") });
  });
});
