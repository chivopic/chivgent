# chivgent

> A small, readable coding-agent CLI for learning how an agent harness actually
> works.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)
[![CI](https://github.com/chivopic/chivgent/actions/workflows/ci.yml/badge.svg)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-MVP-orange)

`chivgent` connects a Provider-independent agent loop to LLM APIs, tools, and a
workspace boundary. The current MVP can inspect a local project with a safe,
read-only `read_file` tool and answer questions using OpenAI, DeepSeek, or any
compatible Chat Completions endpoint.

The project is intentionally compact: it is designed to make the mechanics of
tool calling, conversation state, Provider adapters, and loop termination easy
to study before adding production-harness complexity.

## Features

- A real multi-turn agent loop: model -> tool call -> tool result -> model.
- Provider-independent runtime messages and tool contracts.
- OpenAI support through the Responses API.
- DeepSeek support through a reusable OpenAI-compatible Chat Completions client.
- Custom OpenAI-compatible endpoints through environment-only configuration.
- Safe, read-only workspace access with traversal and symlink-escape protection.
- Tool argument validation, explicit tool errors, and an eight-turn safety limit.
- A packaged Node.js CLI with no framework dependency.
- Unit tests that do not spend API credits.

## Quick start

### Requirements

- Node.js 20 or newer
- npm
- An API key for OpenAI, DeepSeek, or a compatible Provider

### Install from source

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

The CLI prints only the final answer. Provider failures and diagnostics go to
stderr and produce a non-zero exit code.

## CLI reference

```text
chivgent [--provider openai|deepseek|openai-compatible] [--model MODEL] "question"

Options:
  --provider NAME  openai, deepseek, or openai-compatible (default: openai)
  --model MODEL    Provider model override
  -h, --help       Show help
  -v, --version    Show version
```

### Provider configuration

| Provider | API key | Model environment variable | Default model | API style |
| --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.6` | Responses API |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-v4-flash` | OpenAI-compatible Chat Completions |
| Custom compatible | `OPENAI_API_KEY` | `OPENAI_MODEL` | Required | OpenAI-compatible Chat Completions |

An explicit `--model` value takes precedence over the Provider-specific model
environment variable. Custom compatible Providers also require
`OPENAI_BASE_URL`.

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
                 +-> Tool Registry -> read_file -> Workspace
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
  agent.ts                       Agent loop and run state
  llm.ts                         Provider-independent LLM contract
  messages.ts                    Runtime message model
  workspace.ts                   Safe local workspace access
  providers/
    openai.ts                    OpenAI Responses adapter
    openai-compatible-chat.ts    Shared Chat Completions adapter
    deepseek.ts                  DeepSeek configuration wrapper
  tools/
    tool.ts                      Tool contract
    read-file.ts                 Read-only file tool
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

Build a locally installable tarball:

```bash
npm pack
npm install -g ./chivgent-0.3.0.tgz
```

Tests use scripted or mocked LLM clients. A real API smoke test is deliberately
manual so the default test suite never consumes credits.

## Security model

- API keys are read from environment variables and must never be committed.
- A custom `OPENAI_BASE_URL` receives the configured API key and prompts; use
  only endpoints you trust.
- The only current tool is read-only.
- Paths must remain inside the current workspace.
- Real-path checks block `..` traversal and symlink escapes.
- File size and binary-content checks limit unsafe reads.
- Tool inputs are untrusted and validated before execution.
- The agent stops after a bounded number of model turns.

This is an educational MVP, not a hardened sandbox. Review the code and threat
model before granting future write or shell tools access to sensitive projects.

## Roadmap

- [x] Minimal tool-calling agent loop
- [x] Safe `read_file` tool
- [x] OpenAI and DeepSeek Providers
- [x] Reusable OpenAI-compatible Chat Completions adapter
- [x] Custom OpenAI-compatible CLI Provider
- [ ] Streaming output and runtime events
- [ ] Persistent multi-turn sessions
- [ ] Context-window management and compaction
- [ ] Permission-gated `write_file`, `edit_file`, and shell tools
- [ ] Provider registry and user configuration file
- [ ] TUI, extensions, telemetry, and evals

## Documentation

- [Stage 1: Minimal Agent design](docs/stage-1-minimal-agent.md)
- [DeepSeek Provider design](docs/deepseek-provider.md)

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
