# Web search

`web_search` lets the Agent look up current information. It is off by default.
Select a backend at launch. Add `--approve-web-search` to approve its queries
for that process, including in the TUI.

```sh
chivgent --provider deepseek --web-search deepseek --approve-web-search
chivgent --web-search https://search.example.com --approve-web-search
```

## Backend

With `--web-search deepseek`, the adapter calls the official
[DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search/).
It uses the DeepSeek API key from the environment or saved CLI credentials,
or the explicit `--api-key` when the startup model provider is DeepSeek.
Successful searches can incur a separate charge.

A URL selects a [SearXNG](https://docs.searxng.org/) instance with its JSON
API enabled (`format=json`). The adapter appends `/search` when needed.

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
| `--approve-web-search` with a backend | Approves that backend's queries for this process. Shell and write approvals follow their own policy. |
| `ask-first` | Each query prompts with the provider and the exact query text. Enter denies. |
| `workspace` | Each query prompts. A web search is network access, so it is not covered by the workspace grant. |
| `unrestricted` | Queries run without a prompt. |
| Legacy flags (`--allow-writes`, `--allow-shell`, …) | `--web-search` itself is the explicit consent; there is no per-query policy. |
| Non-interactive `ask-first`/`workspace` without startup search approval | No approval channel exists, so the tool returns a denial and sends nothing. |

`/permissions` changes the process policy as usual. `/status` names the
configured search provider and shows explicit startup approval. Saved conversations
do not restore this approval. The per-query prompt wraps long queries instead of
truncating them, so the user sees what leaves the machine. A denial, a missing
approval channel, or cancellation produces a tool error and no request.

The tool authorizes the query inside its own execution path. An extension, an
Agent-level `authorizeToolCall`, or injected context cannot replace that check.
Extensions cannot register a tool named `web_search`.

## Privacy and bounds

The adapters send the normalized query and protocol parameters. SearXNG receives
only its optional search token. DeepSeek Search sends the DeepSeek key only to
the official DeepSeek endpoint. Neither adapter attaches conversation history
or workspace files. A SearXNG URL must be an absolute HTTP(S) URL without
embedded credentials, a query string, or a fragment. Both adapters refuse redirects.

The prompt tells the model not to put credentials, private file contents, or
unrelated conversation into a query. The approval prompt shows the full query,
and the adapter emits no request when approval is denied.

| Limit | Value |
| --- | --- |
| Results per call | 5 by default, 10 maximum |
| Query | DeepSeek: 128 characters. SearXNG: 256 characters. Control characters are rejected. |
| Title / snippet / date | 200 / 400 / 64 characters |
| Result URL | 2048 characters, `http` or `https` only, no credentials |
| HTTP timeout | 10 seconds, including reading the response body |
| Client rate limit | 10 searches per minute per session |
| Response body | 256 KiB |

Results are normalized, de-duplicated by URL, and treated as untrusted data.
The tool output starts with that warning and serializes every result as JSON, so
titles and snippets cannot become instructions or forge the surrounding format.
Search-enabled sessions supply the UTC date at the start of each run to the model
for time-sensitive questions.
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

Run the [web search evaluation](evals.md#web-search) to compare factual answers,
retrieved evidence, and citation support through the CLI.
