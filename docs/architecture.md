# chivgent architecture

> Moved out of the top-level README in the README rewrite. Content unchanged unless noted.

## Overview

```text
                                  +-> OpenAI Responses API
User -> CLI -> Agent -> LLMClient |
                 |                +-> OpenAI-compatible Chat -> DeepSeek / custom
                 |
                 +-> Tool Registry -> list_files / search_text / read_file -> Workspace
                 |                    write_file / edit_file (--allow-writes)
                 |                    bash (--allow-shell) -> Seatbelt on macOS / Docker elsewhere
                 |                    web_search (--web-search) -> configured SearXNG JSON API
```

The Agent runtime owns its own messages. Provider-specific schemas are converted
only at the `LLMClient` boundary:

```text
Agent Message[] -> Provider adapter -> Provider request
                                     <- Provider response
AssistantMessage <- normalized result
```

This prevents the Agent, tools, and CLI from depending on one vendor's message
format.

### Agent instructions

`src/prompts.ts` defines the same baseline instructions for interactive runs and
evals. The baseline separates identity, task workflow, and evidence requirements.
`createLocalSession` in `src/cli-runtime.ts` adds write/shell instructions
only when those tools are registered, plus process-local permission policy and
extension contributions. This is inspired by Codex's layered instructions, but
tool access remains enforced by chivgent's runtime, not by text.

The agent identifies itself as **chivgent**, not as an unverifiable underlying
provider model. A provider/model selection shown by the CLI is configuration,
not proof of which backend implementation served a request. Model-specific
wire formats remain the responsibility of the Provider adapter.

### Context management

A session records everything that happened. The context manager decides what
is worth sending for one request. Keeping those apart is what lets a long
session stay inside a fixed context window.

```text
Full transcript ──────────────→ Session store (what happened)
       │
       ↓
ContextManager
       │  token estimate vs. contextWindow - reserveTokens
       ↓
summary + recent messages ────→ Provider (what the model sees)
```

A summary response with no non-whitespace text is rejected before it can become
a checkpoint. This includes a parsed JSON `summary` field that is empty or only
whitespace; non-JSON prose remains a valid fallback summary, and JSON without a
string `summary` field keeps the existing raw-text fallback. The full transcript
and any prior checkpoint remain in place; reported usage from that completed
call is still included in the run or session total. Cancellation is checked
after the Provider returns and immediately before a manual session starts its
checkpoint append, so a Provider that ignores the signal or a header write that
waits cannot install a late candidate. Starting the checkpoint append is the
manual persistence commit point.

When the estimate exceeds the budget, older messages are summarised into a
single message and recent turns are kept verbatim. Four details matter:

- **The summary request has the same input budget.** Before each automatic or
  manual summary call, the ContextManager estimates the summary instructions
  and the transcript exactly as rendered for that call, using the same
  estimator and `contextWindow - reserveTokens` budget as an agent request.
  This includes an earlier summary when it is part of the history being
  summarised. If it does not fit, the request is refused locally; no summary
  call is sent and the transcript and existing checkpoint stay intact. The
  configured context window can be raised when the selected Provider accepts
  the larger request, or the user can start a new session.

- **File lists are derived from tool calls, not from the summary.** A summary
  can forget or invent a path. For a coding agent, "which files did I read and
  change" is the part that most needs to survive intact, so it is collected
  from the `read_file`, `write_file`, and `edit_file` calls themselves.
- **Tool calls are never separated from their results.** A split point that
  would orphan a tool result moves forward past the whole group.
- **Compaction discards the Provider continuation.** A Provider that chains
  history server-side replays its own copy and ignores the messages sent with
  it, so keeping the continuation would send back the history just removed.

Token counts are estimated from character length rather than with a real
tokenizer, which would be model-specific and a large dependency for a number
that only decides *when* to compact. The reserve budget absorbs the error.

A single tool result larger than the whole budget cannot be compacted away;
bound tool output instead. Compaction is disabled with `--no-compaction`.

### Runtime events

The Agent Loop reports what it is doing through a typed event stream instead of
printing anything itself. One run emits:

```text
agent_start
  turn_start -> message_start -> message_update* -> message_end
    tool_execution_start -> tool_execution_end   (once per tool call)
  turn_end
  ...
agent_end (completed | max_turns | aborted | error)
```

`message_update` carries deltas only, never a cumulative snapshot, so the stream
stays linear in the length of the answer. Events are structured-cloneable and
each listener receives a copy, so a renderer can never mutate the transcript.
The CLI renderer in `src/render.ts` is one consumer; a log file, a JSON stream,
or a TUI are others.

`LLMClient.stream` is optional. When a Provider does not implement it, the Agent
falls back to `complete` and the same events are emitted without deltas.

### OpenAI-compatible Providers

Compatible Providers reuse the official `openai` npm package by changing
`baseURL`, credentials, and model. CLI users do not need to edit code:

```bash
export OPENAI_API_KEY="your-provider-api-key"
export OPENAI_BASE_URL="https://api.vendor.example/v1"
export OPENAI_MODEL="vendor-model"

chivgent --provider openai-compatible "What does src/agent.ts do?"
```

`OPENAI_BASE_URL` must point to the Provider's OpenAI-compatible API root. The
Provider must implement `POST /chat/completions` and function tool calling.
The adapter omits the optional `tools` field when no tools are available
(e.g. context-compaction requests); registered tool definitions are unchanged.

When adding a named Provider in source code, use the same adapter:

```ts
const client = new OpenAICompatibleChatClient({
  apiKey: process.env.VENDOR_API_KEY!,
  baseURL: "https://api.vendor.example/v1",
  model: "vendor-model",
  continuationTag: "vendor-chat",
});
```

`DeepSeekChatClient` is a small configuration wrapper around this shared client.
The compatibility layer also preserves optional Provider-only fields such as
DeepSeek's `reasoning_content` inside opaque continuation state.

Provider adapters also expose an optional `reportedModel` on `LLMResponse` when the API supplies a model ID. The Agent forwards it to `message_end` events (including JSON event streams), but deliberately does not place it in conversation history: server-provided model IDs are diagnostics, may be aliases, and are not proof of underlying model weights. Missing metadata stays missing, never guessed from the requested model. This mirrors OpenCode's distinction between selected catalog identity and provider API identity.

Changing only `baseURL` is not a promise of complete compatibility. Providers
can differ in model names, authentication, tool-schema support, strict mode,
reasoning fields, streaming events, and error behavior. Keep those differences
inside thin Provider adapters rather than leaking them into the Agent loop.


## The rich terminal interface

Local interactive sessions use the rich terminal interface when stdin, stdout,
and stderr are terminals. `--simple` selects the append-only interface, while
`--tui` explicitly requests the rich interface. It draws a status region above
the prompt while a run is in progress: the
turn, whether the model is thinking or running tools, which tools are running
with what they are aimed at and their newest output, elapsed time, and the
running token count. Long single-line replies keep their newest text visible;
long paths retain the filename and tool progress. On narrow terminals, the
status and stop shortcut take priority.

```text
Let me look at how sessions are stored.
  read_file src/session.ts (2s)
  search_text (1s)  src/store.ts:41: export class SessionStore
running tools  ·  turn 2/8  ·  11s  ·  4.2k tokens  ·  ctrl+c to stop
```

It is the first consumer of the event stream that runs backwards. Every other
one — streamed output, the session log, extensions, the remote client — is
append-only: an event arrives, it is printed, it is forgotten. This one has to
rebuild *what is happening now* from the same stream and keep it right as more
arrives, which splits into three pieces:

```text
reduce(state, event, now)  ->  ViewState     pure
view(state, {width, now})  ->  string[]      pure
paint(previous, next)                        the only part that touches a terminal
```

Both pure pieces are tested without a terminal, which is where the real
guarantees live. One asymmetry in the event vocabulary is what makes the state
model load-bearing: `message_update` carries a **delta**, `tool_execution_update`
carries a truncated **snapshot**. Appending a snapshot stacks output that was
never produced — the window has already had its front dropped — and replacing on
a delta leaves the last token and loses the answer. An append-only renderer
never has to know the difference, because it just prints whatever arrives. Two
tests fail when either is written the wrong way round.

It does not take the alternate screen buffer. That would cost the scrollback,
and getting it back means reimplementing scrolling, search and selection —
thousands of lines that teach terminal graphics rather than agent architecture.
A finished turn is flushed to the terminal's own scrollback and dropped from
the state, so a long session never grows it. The inline composer holds SGR
mouse tracking for its own hit testing, so a wheel-up over the transcript is
handed back to the terminal instead of being consumed as a caret move; the
next keystroke takes the mouse back. Input stays with readline for the same
reason: a line editor is not the interesting problem here.

Painting rewrites only the lines whose content changed, so a ticking timer
costs one line rather than a repaint. A resize invalidates that baseline — the
terminal has reflowed what is on screen — and is the one moment a full repaint
is correct rather than lazy.

Automatic selection stays simple for piped streams, one-shot prompts, JSON,
`--serve`, `--connect`, and `TERM=dumb`. Explicit `--tui` still requires an
interactive session and terminals on stdin and stderr; it can write final
answers to redirected stdout. It refuses incompatible explicit requests rather
than silently ignoring the switch. `NO_COLOR` disables styling without changing
the selected interface. The startup wordmark shows the Provider, model, workspace and next action;
use `/session` for the session id. Type `/` to open the inline command menu
(including extension commands); Up/Down selects, Tab completes, and Enter runs.
Outside a menu, Up/Down browses input history. During a run ordinary typing is ignored; Ctrl+C cancels immediately.
At an idle prompt Ctrl+C exits, clearing the draft and returning the terminal
to the shell. Ctrl+D on an empty line also exits.
Input is single-line: only the first submitted line in an input batch is accepted.
Wait for the prompt before sending another question.
After cancellation the prompt is ready again and partial text stays in scrollback.
A completion line records the outcome, elapsed time and reported token usage.

Chinese, combining characters and joined emoji are clipped by terminal columns;
short terminals keep the status visible. Resizing repaints the existing region.
All prompts and UI output go to stderr; stdout receives final answers only, so
`chivgent --tui > answers.txt` keeps the terminal interactive while saving answers.

```sh
npm run build
node dist/cli.js --tui
npm run demo:tui  # Offline interactive demo; no API key or network required
```

The demo uses a stub Provider and simulated tool progress; it does not modify the
workspace. See [the TUI guide](tui.md) for controls and verification.

## Project structure

```text
src/
  cli.ts                         CLI entry point and process boundary
  cli-options.ts                 Argument and Provider configuration
  auth/
    credentials.ts               Credential contract and resolution order
    runtime-credentials.ts       --api-key override
    env-credentials.ts           Environment variable lookup
    file-credentials.ts          The auth.json store, read and write
  agent.ts                       Agent loop and run state
  events.ts                      Runtime event model
  render.ts                      Terminal renderer for runtime events
  llm.ts                         Provider-independent LLM contract
  retry.ts                       Provider timeout and retry decorator
  messages.ts                    Runtime message model
  session.ts                     Conversation state and event fan-out
  session-store.ts               JSONL session log and resume support
  repl.ts                        Interactive prompt and slash commands
  context/
    context-manager.ts           Builds the messages for one request
    compaction.ts                Summarises old history and tracks files
    token-estimator.ts           Character-based token approximation
  workspace.ts                   Workspace configuration and the read-only default
  workspace/
    types.ts                     Limits, errors, and the Workspace contract
    paths.ts                     Path normalisation and escape protection
    ignore.ts                    .gitignore and generated-directory filtering
    text.ts                      UTF-8 decoding, line splitting, previews
    read.ts                      Ranged reads
    list.ts                      Directory walking
    search.ts                    Literal text search
    write.ts                     Atomic whole-file writes and exact edits
  providers/
    registry.ts                  Provider registry
    usage.ts                     Reading and adding up Provider token counts
    deferred-client.ts           A client whose Provider can arrive later
    definitions.ts               Built-in Provider declarations
    client.ts                    Credential resolution into an LLM client
    openai.ts                    OpenAI Responses adapter
    openai-compatible-chat.ts    Shared Chat Completions adapter
    deepseek.ts                  DeepSeek configuration wrapper
  tools/
    tool.ts                      Tool contract
    output.ts                    Shared 64 KiB tool-output boundary
    list-files.ts                Deterministic project-tree discovery
    search-text.ts               Bounded literal source search
    read-file.ts                 Ranged text-file reader
    write-file.ts                Whole-file create and replace
    edit-file.ts                 Exact unique-match edit
    bash.ts                      Shell command execution
    web-search.ts                Permission-gated, bounded web search
  websearch/
    backend.ts                   WebSearchBackend contract and SearXNG adapter
  prompts.ts                     The instructions the agent runs under
  evals/
    task.ts                      Task definitions and their validation
    fixture.ts                   A fresh workspace copy per attempt
    graders.ts                   Deterministic graders
    runner.ts                    Runs a task N times and aggregates
    report.ts                    Table and JSON output
    parse-args.ts                Eval CLI arguments
    cli.ts                       npm run eval
  remote/
    protocol.ts                  Message shapes and version negotiation
    framing.ts                   JSON Lines framing with a bounded buffer
    server.ts                    Serves one session on a Unix socket
    client.ts                    Attaches to a served session
    repl.ts                      The interactive loop for an attached client
    socket-path.ts               Socket paths, staleness, and discovery
  extensions/
    trust.ts                     Per-directory trust store
    decide-trust.ts              The prompt, and the refusal when nobody can answer
    discover.ts                  Where extensions live and which files count
    api.ts                       What an extension may register
    registry.ts                  Collects registrations, rejects conflicts
    loader.ts                    Imports modules and contains their failures
  shell/
    types.ts                     Execution contract and shell error types
    config.ts                    Shell resolution and the Windows guard
    local.ts                     Local spawn backend
    process.ts                   Process-group kill and exit handling
    output.ts                    Bounded streaming output accumulator
    truncate.ts                  Tail truncation for command output
    sanitize.ts                  Control-character filtering
tests/                           Provider, loop, and workspace tests
evals/                           Eval tasks and their fixtures
docs/                            Architecture and learning notes
```

