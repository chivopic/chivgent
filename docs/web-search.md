# Web search

`web_search` lets the Agent look up current information without assuming the
selected model has a hosted search tool. It is off by default and is registered
only when the user names a backend.

```sh
chivgent --web-search https://search.example.com "What changed in Node.js 24?"
CHIVGENT_WEB_SEARCH_TOKEN=… chivgent --web-search https://search.example.com
```

## Backend

The first backend is a [SearXNG](https://docs.searxng.org/) instance with its
JSON API enabled (`format=json`). `--web-search` takes the instance base URL;
`/search` is appended unless the URL already ends with it.

The bearer token is read from `CHIVGENT_WEB_SEARCH_TOKEN`. It is not accepted
on the command line, because arguments are visible in process listings. The
token is sent only by the search adapter, never to the model provider, the
session log, or tool output.

Adding another search service means implementing `WebSearchBackend` in
`src/websearch/backend.ts`. The tool, permission checks, bounds, and event
reporting stay the same.

## Permissions

| Session | Behavior |
| --- | --- |
| No `--web-search` | `web_search` is not registered or described to the model. |
| `ask-first` | Each query prompts with the provider and the exact query text. Enter denies. |
| `workspace` | Each query prompts. A web search is network access, so it is not covered by the workspace grant. |
| `unrestricted` | Queries run without a prompt. |
| Legacy flags (`--allow-writes`, `--allow-shell`, …) | `--web-search` itself is the explicit consent; there is no per-query policy. |
| Non-interactive `--permission-mode ask-first`/`workspace` | No approval channel exists, so the tool returns a denial and sends nothing. |

`/permissions` changes the process policy as usual. `/status` names the
configured search provider. The approval prompt wraps long queries instead of
truncating them, so the user sees what leaves the machine. A denial, a missing
approval channel, or cancellation produces a tool error and no request.

The tool authorizes the query inside its own execution path. An extension, an
Agent-level `authorizeToolCall`, or injected context cannot replace that check.
Extensions cannot register a tool named `web_search`.

## Privacy and bounds

Only the normalized query and `format=json` leave the process. Provider keys,
conversation history, and workspace files are not attached. The endpoint must
be an absolute `http` or `https` URL without embedded credentials, a query
string, or a fragment; redirects are refused.

The prompt tells the model not to put credentials, private file contents, or
unrelated conversation into a query. The approval prompt shows the full query,
and the adapter emits no request when approval is denied.

| Limit | Value |
| --- | --- |
| Results per call | 5 by default, 10 maximum |
| Query | 256 characters, no control characters |
| Title / snippet / date | 200 / 400 / 64 characters |
| Result URL | 2048 characters, `http` or `https` only, no credentials |
| HTTP timeout | 10 seconds |
| Client rate limit | 10 searches per minute per session |
| Response body | 256 KiB |

Results are normalized, de-duplicated by URL, and treated as untrusted data.
The tool output starts with that warning and serializes every result as JSON, so
titles and snippets cannot become instructions or forge the surrounding format.
HTTP 429, other non-success statuses, timeouts, unreadable bodies, and malformed
JSON become bounded tool errors with no response body. Failures are not retried.

`web_search` does not fetch arbitrary pages. `web_fetch` and browsing remain a
separate change.

## Verification

`tests/web-search.test.ts` covers the adapter against a local HTTP fake,
normalization and bounds, denial without network, cancellation, timeout, HTTP
429, the client rate limit, Agent event reporting, and the Agent-level bypass
attempt. `tests/permissions.test.ts` covers the approval context, and
`tests/cli-options.test.ts`, `tests/cli-runtime.test.ts`, and
`tests/cli-ui-wiring.test.ts` cover the flag, registration, and CLI wiring.
