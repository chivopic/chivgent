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
- An opt-in `bash` tool behind `--allow-shell`, with streamed output.
- Remote sessions: one process holds a session, others attach over a local socket.
- Several clients can watch one session; any of them can interrupt the run.
- Extensions that add tools, slash commands, event handlers and prompt text.
- Project extensions gated by a per-directory trust decision, taken before any
  module is imported and refused outright when there is no terminal to ask.
- Commands run in their own process group, so cancelling kills the whole tree.
- Command output is truncated from the tail; the full text goes to a temp file.
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
  --provider NAME  openai, deepseek, openai-compatible, openrouter, groq, xai,
                   moonshot (default: openai)
  --model MODEL    Provider model override
  --max-turns N    Tool-calling turn limit (default: 8, 16 with --allow-writes
                   or --allow-shell)
  --no-stream      Wait for the full answer instead of streaming tokens
  -q, --quiet      Hide tool activity on stderr
  --json           Write the run as JSON lines instead of rendered text
  -c, --continue   Resume the most recent session for this workspace
  --resume ID      Resume a specific session
  --api-key KEY    API key for this run; prefer an environment variable
  --sessions       List recorded sessions and exit
  --allow-writes   Let the agent create and change files (default: read-only)
  --allow-shell    Let the agent run shell commands. This implies write access:
                   a shell is not bound by the workspace. Unix only.
  --serve          Expose this session on a local socket and keep running
  --connect TARGET Attach to a served session, by id or socket path
  --servers        List the servers still answering, then exit
  --no-extensions  Do not load any extension, and do not ask about trust
  --extensions     List loaded extensions and what they register, then exit
  --forget-trust   Forget the trust decision covering this workspace, then exit
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
                 |                    write_file / edit_file (--allow-writes)
                 |                    bash (--allow-shell) -> ShellOperations
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
    bash.ts                      Shell command execution
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

## Remote sessions

A session normally lives and dies with the terminal that started it. `--serve`
keeps it in one process and lets others attach:

```bash
# One terminal
chivgent --serve --allow-writes
# chivgent 0.12.0 serving session 2026-09-06T...
# socket:       ~/.chivgent/sockets/2026-09-06T....sock
# capabilities: --allow-writes

# Another terminal
chivgent --servers                 # list what is running
chivgent --connect <id>            # attach interactively
chivgent --connect <id> "question" # ask once and leave
```

A client holds no state: it sends prompts and renders the event stream the
server broadcasts. Several clients can attach at once — the extra ones watch the
same run as it happens, and any of them can interrupt it, because the run
belongs to the session rather than to whoever started it. A prompt sent while
another is running is refused rather than queued, and a client that disconnects
mid-run does not cancel it.

Attaching does not replay history; the session log already holds that. The
protocol is JSON Lines over a Unix socket, one object per line, the same shape
`--json` writes.

**Whoever can reach the socket has everything the server was started with.** If
it was started with `--allow-shell`, anyone who can connect can make the model
run commands, which is why the server prints its capabilities on startup: the
person attaching cannot see the flags you typed. The boundary is filesystem
permissions — sockets live in an owner-only directory under `CHIVGENT_HOME` —
and there is no TCP listener. For another machine, forward the socket over SSH
so that authentication is SSH's job.

## Extensions

An extension is an ES module that default-exports a function. It is called once
at startup with an API that can add a tool, add a slash command, subscribe to
runtime events, and append to the system prompt.

```js
// .chivgent/extensions/word-count.js
export default function (api) {
  api.registerTool({
    name: "word_count",
    description: "Count the words in a workspace file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context) {
      const file = await context.workspace.readTextFile(args.path);
      return {
        content: `${file.content.split(/\s+/).filter(Boolean).length} words`,
        isError: false,
      };
    },
  });

  api.contributeSystemPrompt("Use word_count instead of reading a file to count words.");
}
```

Extensions are loaded from two places:

| Location | Loaded |
| --- | --- |
| `<CHIVGENT_HOME>/extensions/` | Always: it is your own machine's configuration |
| `<workspace>/.chivgent/extensions/` | Only after you trust the project |

Both accept `name.js` and `name/index.js`; nesting stops there. Plain JavaScript
only — compiling TypeScript yourself is cheaper than making chivgent carry a
TypeScript loader. A name already taken by a built-in tool or command is refused,
so an extension cannot shadow `read_file` or `/clear`, and a broken extension is
reported and skipped rather than taking chivgent down with it.

`chivgent --extensions` lists what loaded and what each one registered.

### Project trust

The first time you run chivgent in a project that ships extensions, it describes
what they are and asks once. The answer is stored in `<CHIVGENT_HOME>/trust.json`
against the resolved directory path, and matched by nearest ancestor, so trusting
`~/work` covers every repository under it. `--forget-trust` removes the decision
covering the current workspace.

**Trusting a project means letting its authors run code as you.** An extension
executes inside the chivgent process: it is not bound by the workspace, it does
not need `--allow-shell` to run a command, and it can read your environment
including the API key. That is why the question is asked before anything is
imported, and why the answer is no whenever there is nobody to ask — a CI job or
a piped run never loads a checkout's extensions on its own.

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
- The `bash` tool needs `--allow-shell`, which is separate from `--allow-writes`
  and never implied by it. Granting it grants far more: a shell can change or
  delete anything the user running chivgent can, inside the workspace or not,
  and none of the workspace limits below apply to it.
- Commands are spawned in their own process group and killed as a group, so
  cancelling a run does not leave descendants behind.
- Commands inherit chivgent's environment, which includes the API key it is
  using. A model with `--allow-shell` can read that key and anything else the
  environment holds. Run it with an environment that carries only what the task
  needs.
- Truncated command output is written to a temp file so the model can read the
  rest. The file is owner-only, but it is not deleted when the run ends: it can
  hold anything the command printed. Clear the temp directory after sensitive
  work.
- Session logs record command output as well as file excerpts once
  `--allow-shell` is on.
- Project extensions are loaded only after an explicit, recorded trust decision,
  and never without a terminal to ask at. An extension runs in-process with your
  permissions and is bound by none of the workspace limits above, so trusting a
  project is the same order of authority as `--allow-shell`, reached by cloning
  a repository rather than by typing a flag.
- User extensions under `<CHIVGENT_HOME>/extensions/` are always loaded; that
  directory is your own configuration.
- Extensions cannot take the name of a built-in tool or command.
- `trust.json`, like the session log and the auth file, is written owner-only.
- A served session is reachable by anyone who can open its socket, and they get
  every capability the server was started with. Sockets live in an owner-only
  directory; the directory is the real gate, because a socket file exists
  briefly with default permissions before it can be restricted.
- chivgent never listens on TCP. Use SSH forwarding to reach another machine.
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

This is an educational MVP, not a hardened sandbox. There is no permission
system: capabilities are coarse, session-level switches, and neither
`--allow-writes` nor `--allow-shell` asks for per-action confirmation. That is
deliberate. Once a shell exists, a command allowlist is bypassed by a single
`sh -c`, and a prompt on every action only trains people to approve without
reading, so chivgent states the boundary instead of pretending to enforce one.

Use these switches on work you have committed. If you need a real boundary,
put the whole process in a container and give that container only what the task
needs. Review the code and threat model before pointing chivgent at a sensitive
project.

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
- [x] Provider registry and credential resolution chain
- [x] `bash` tool with streaming output, behind `--allow-shell`
- [x] Extensions and project trust
- [x] Remote sessions over a local socket
- [ ] TUI, telemetry, and evals

Per-command confirmation prompts and command allowlists are deliberately not
planned. Once a shell tool exists, `bash` can do anything `write_file` can and
more, so an allowlist is bypassed by a single `sh -c` and a per-command prompt
only trains people to approve without reading. Capabilities are coarse,
session-level switches; the real boundary is a container.

## Documentation

- [Stage 1: Minimal Agent design](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider design](docs/deepseek-provider.md)
- [Stage 2: Project Discovery implementation design](docs/stage-2-project-discovery.md)
- [Stage 3: Runtime Events and Streaming design](docs/stage-3-runtime-events.md)
- [Stage 4: Sessions and interactive mode design](docs/stage-4-sessions.md)
- [Stage 5: Write tools and the workspace split](docs/stage-5-write-tools.md)
- [Stage 6: Provider registry and credential chain](docs/stage-6-provider-registry.md)
- [Stage 7: Context budget and compaction](docs/stage-7-context-management.md)
- [Stage 8: Shell tool and streaming subprocesses](docs/stage-8-shell-tool.md)
- [Stage 9: Extensions and project trust](docs/stage-9-extensions.md)
- [Stage 10: Remote sessions](docs/stage-10-remote-sessions.md)
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
