# chivgent

[English](README.md) | [简体中文](README.zh-CN.md)

> A small, readable coding-agent CLI for learning how an agent harness actually
> works.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)
[![CI](https://github.com/chivopic/chivgent/actions/workflows/ci.yml/badge.svg)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-MVP-orange)

`chivgent` connects a Provider-independent agent loop to LLM APIs, tools, and a
workspace boundary. The current MVP can discover files, search source text, and
read bounded file ranges before answering with OpenAI, DeepSeek, or any
compatible Chat Completions endpoint.

The project is intentionally compact: it is designed to make the mechanics of
tool calling, conversation state, Provider adapters, and loop termination easy
to study before adding production-harness complexity.

## Features

- A real multi-turn agent loop: model -> tool call -> tool result -> model.
- Provider-independent runtime messages and tool contracts.
- A Provider registry: adding a Provider is a declaration, not a CLI change.
- API keys resolved from `--api-key`, the environment, then an optional file.
- OpenAI support through the Responses API.
- DeepSeek support through a reusable OpenAI-compatible Chat Completions client.
- Custom OpenAI-compatible endpoints through environment-only configuration.
- An interactive session with slash commands, or a single-shot question.
- Sessions that persist as JSON lines and can be resumed in a later process.
- A context manager that summarises old turns to stay inside the window.
- A `--json` event stream for scripting and other front ends.
- Streamed answers rendered from a typed runtime event stream.
- Interruptible runs: Ctrl+C ends the current run without losing the transcript.
- Per-attempt Provider timeouts and bounded exponential-backoff retries.
- Deterministic project discovery through `list_files` and literal `search_text`.
- Ranged `read_file` output with continuation hints and bounded tool results.
- Read-only by default; `--allow-writes` adds `write_file` and `edit_file`.
- Exact-match `edit_file` that refuses missing or ambiguous edits.
- Edits preserve the file's own byte order mark and CRLF line endings.
- Atomic writes: a crash mid-write leaves the original file intact.
- Safe workspace access with traversal and symlink-escape protection.
- Root `.gitignore`, generated-directory, and sensitive-path filtering.
- Tool argument validation, explicit tool errors, and a bounded turn limit.
- A packaged Node.js CLI with no framework dependency.
- Unit tests that do not spend API credits.

## Quick start

### Requirements

- Node.js 20 or newer
- npm
- An API key for OpenAI, DeepSeek, or a compatible Provider

### Install from npm

```bash
npm install -g chivgent
chivgent --version
```

To install the current source checkout instead:

```bash
git clone https://github.com/chivopic/chivgent.git
cd chivgent
npm install
npm run build
npm install -g .
```

### Ask about a project

Run `chivgent` from the project you want it to inspect.

With OpenAI:

```bash
export OPENAI_API_KEY="your-api-key"
chivgent "What does src/agent.ts do?"
```

With DeepSeek:

```bash
export DEEPSEEK_API_KEY="your-api-key"
chivgent --provider deepseek "Explain the architecture in src/"
```

With any OpenAI-compatible Chat Completions endpoint:

```bash
export OPENAI_API_KEY="your-provider-api-key"
export OPENAI_BASE_URL="https://api.vendor.example/v1"
export OPENAI_MODEL="vendor-model"

chivgent --provider openai-compatible "Explain the architecture in src/"
```

Start an interactive session by running `chivgent` with no question:

```bash
chivgent
› What does src/agent.ts do?
› Where is that loop tested?
› /exit
```

The conversation is kept across prompts, so follow-up questions do not repeat
the earlier context. Resume it later with `chivgent --continue` (or
`chivgent --resume <id>`; `chivgent --sessions` lists what is recorded).

Answers stream to stdout as the model produces them, so stdout stays pipeable.
Tool activity, retries, and run status go to stderr; Provider failures produce a
non-zero exit code. Use `--no-stream` for one final write, and `--quiet` to hide
tool activity.

## CLI reference

```text
chivgent [options] "question"     Answer one question and exit
chivgent [options]                Start an interactive session

Options:
  --provider NAME  openai, deepseek, or openai-compatible (default: openai)
  --model MODEL    Provider model override
  --max-turns N    Tool-calling turn limit (default: 8, 16 with --allow-writes)
  --no-stream      Wait for the full answer instead of streaming tokens
  -q, --quiet      Hide tool activity on stderr
  --json           Write the run as JSON lines instead of rendered text
  -c, --continue   Resume the most recent session for this workspace
  --resume ID      Resume a specific session
  --api-key KEY    API key for this run; prefer an environment variable
  --sessions       List recorded sessions and exit
  --allow-writes   Let the agent create and change files (default: read-only)
  --context-window N  Token budget for the context (default: 128000)
  --no-compaction  Send the whole transcript instead of summarising old turns
  --no-session     Do not record this run
  -h, --help       Show help
  -v, --version    Show version
```

In an interactive session, `/help` lists the slash commands: `/session`,
`/tools`, `/clear`, and `/exit`. Ctrl+C stops the answer in progress without
leaving the session; Ctrl+D leaves it.

Exit codes: `0` answered, `1` configuration or Provider failure, `2` turn limit
reached, `130` interrupted with Ctrl+C.

### Provider configuration

| Provider | API key | Model environment variable | Default model | API style |
| --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.6` | Responses API |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-v4-flash` | OpenAI-compatible Chat Completions |
| Custom compatible | `OPENAI_API_KEY` | `OPENAI_MODEL` | Required | OpenAI-compatible Chat Completions |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | Required | OpenAI-compatible Chat Completions |
| Groq | `GROQ_API_KEY` | `GROQ_MODEL` | Required | OpenAI-compatible Chat Completions |
| xAI | `XAI_API_KEY` | `XAI_MODEL` | Required | OpenAI-compatible Chat Completions |
| Moonshot | `MOONSHOT_API_KEY` | `MOONSHOT_MODEL` | Required | OpenAI-compatible Chat Completions |

An explicit `--model` value takes precedence over the Provider-specific model
environment variable. Custom compatible Providers also require
`OPENAI_BASE_URL`. Sessions are written under `CHIVGENT_HOME` (default
`~/.chivgent`).

Providers are declared in a registry rather than branched on in the CLI, so
`--help` and `--provider` validation are generated from the same list that
creates the client.

#### API key resolution

Keys are resolved in this order, first match wins:

1. `--api-key` for a single run
2. the Provider's environment variable
3. `<CHIVGENT_HOME>/auth.json`

An environment variable deliberately beats the stored file, matching the
convention other CLIs use, so a stored key can be overridden for one run
without editing anything.

`auth.json` is optional and holds literal keys only:

```json
{
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": "sk-..."
}
```

Neither `$VAR` expansion nor `!command` substitution is supported: letting a
config file spawn a process is a large attack surface for a small convenience.
chivgent warns when the file is readable by other users; keep it at `chmod 600`.

```bash
chivgent --provider openai --model gpt-5.6 "Explain package.json"
chivgent --provider deepseek --model deepseek-v4-pro "Explain package.json"
chivgent --provider openai-compatible --model vendor-model "Explain package.json"
```

## Architecture

```text
                                  +-> OpenAI Responses API
User -> CLI -> Agent -> LLMClient |
                 |                +-> OpenAI-compatible Chat -> DeepSeek / custom
                 |
                 +-> Tool Registry -> list_files / search_text / read_file -> Workspace
                                      write_file / edit_file (--allow-writes)
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

When the estimate exceeds the budget, older messages are summarised into a
single message and recent turns are kept verbatim. Three details matter:

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

Changing only `baseURL` is not a promise of complete compatibility. Providers
can differ in model names, authentication, tool-schema support, strict mode,
reasoning fields, streaming events, and error behavior. Keep those differences
inside thin Provider adapters rather than leaking them into the Agent loop.

## Project structure

```text
src/
  cli.ts                         CLI entry point and process boundary
  cli-options.ts                 Argument and Provider configuration
  auth/
    credentials.ts               Credential contract and resolution order
    runtime-credentials.ts       --api-key override
    env-credentials.ts           Environment variable lookup
    file-credentials.ts          Optional auth.json store
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
tests/                           Provider, loop, and workspace tests
docs/                            Architecture and learning notes
```

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Run the complete release gate, including an npm tarball dry run:

```bash
npm run release:check
```

Build a locally installable tarball:

```bash
npm pack
npm install -g ./chivgent-0.6.0.tgz
```

Tests use scripted or mocked LLM clients. A real API smoke test is deliberately
manual so the default test suite never consumes credits.

## Security model

- API keys come from `--api-key`, an environment variable, or an optional
  `auth.json`, in that order, and must never be committed.
- `auth.json` stores keys in plain text. It is opt-in for that reason, and
  chivgent warns when its permissions let other users read it.
- The auth file accepts literal keys only; it cannot expand environment
  variables or run shell commands.
- A custom `OPENAI_BASE_URL` receives the configured API key and prompts; use
  only endpoints you trust.
- Workspace tools are read-only unless `--allow-writes` is passed; `write_file`
  and `edit_file` are not registered at all without it.
- Writes resolve the deepest existing ancestor and reject a symlink at any
  segment, so a planted link cannot redirect a write out of the workspace.
- Writes are staged in a sibling temp file and renamed into place, so an
  interrupted write cannot truncate an existing file.
- `edit_file` refuses an edit whose `old_text` is missing or matches more than
  once, so an imprecise edit fails instead of changing the wrong line.
- Paths must remain inside the current workspace.
- Real-path checks block `..` traversal and symlink escapes.
- File size and binary-content checks limit unsafe reads.
- Discovery respects the root `.gitignore` and fixed generated-directory ignores.
- Common credential and private-key paths are denied across all workspace tools.
- Tool results are limited to 64 KiB; reads, scans, depth, and result counts are bounded.
- Tool inputs are untrusted and validated before execution.
- The agent stops after a bounded number of model turns.
- Session logs under `~/.chivgent/sessions` contain prompts, answers, and tool
  results, including file excerpts. Use `--no-session` in sensitive workspaces,
  and treat the log directory like the project it describes.
- Session ids are validated before they become file paths.

This is an educational MVP, not a hardened sandbox. `--allow-writes` lets the
model change files without a per-edit confirmation prompt, so use it on work
you have committed, and review the code and threat model before pointing it at
a sensitive project.

## Roadmap

- [x] Minimal tool-calling agent loop
- [x] Safe `read_file` tool
- [x] OpenAI and DeepSeek Providers
- [x] Reusable OpenAI-compatible Chat Completions adapter
- [x] Custom OpenAI-compatible CLI Provider
- [x] Project discovery tools: `list_files`, `search_text`, and ranged `read_file`
- [x] Streaming output and runtime events
- [x] Persistent multi-turn sessions
- [x] Context-window management and compaction
- [x] Opt-in `write_file` and `edit_file` behind `--allow-writes`
- [ ] Per-edit confirmation prompts and an undo log
- [ ] Permission-gated shell tools
- [x] Provider registry and credential resolution chain
- [ ] TUI, extensions, telemetry, and evals

## Documentation

- [Stage 1: Minimal Agent design](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider design](docs/deepseek-provider.md)
- [Stage 2: Project Discovery implementation design](docs/stage-2-project-discovery.md)
- [Stage 3: Runtime Events and Streaming design](docs/stage-3-runtime-events.md)
- [Stage 4: Sessions and interactive mode design](docs/stage-4-sessions.md)
- [Release process](docs/releasing.md)

## Contributing

Issues and focused pull requests are welcome. Before submitting a change, run:

```bash
npm run check
npm test
npm run build
```

Please keep Provider-specific types inside `src/providers/` and keep the core
Agent runtime independent from vendor SDK schemas.

## License

Licensed under the [MIT License](LICENSE).
