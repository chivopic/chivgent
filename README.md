<p align="center">
  <img src="docs/assets/chivgent-leaf-mark.png" width="88" alt="">
</p>

<div align="center">

# chivgent

### A coding agent in your terminal.

**Ask what this repo does. It reads the files. It does not touch them.**<br>
Writes wait for a flag. The shell waits for a yes, inside a sandbox.

[![npm](https://img.shields.io/npm/v/chivgent?color=111111)](https://www.npmjs.com/package/chivgent)
[![CI](https://img.shields.io/github/actions/workflow/status/chivopic/chivgent/ci.yml?label=CI&color=111111)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-111111)
[![License](https://img.shields.io/badge/license-MIT-111111)](LICENSE)

[Architecture](docs/architecture.md) · [Shell](docs/shell-sandbox.md) · [Sign in](docs/subscription-oauth.md) · **English** · [简体中文](README.zh-CN.md)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/turn-dark.svg">
  <img src="docs/assets/turn-light.svg" width="920" alt="One question, three read tools, an answer. The workspace is not changed.">
</picture>

## Is this for you?

You have a project open and a question about it. chivgent asks a model you choose, using the files in the current directory.

- **It starts by reading.** Listing, searching, and reading are on. Nothing is written.
- **You bring the model.** An API key, or the ChatGPT or xAI subscription you sign in to.
- **The boundary is a switch, not a surprise.** Writes are a flag. Each shell command asks, then runs in Seatbelt or Docker.

It runs on your machine. It is not a hosted product. It does not yet do fine-grained permissions, a native Windows shell, or a desktop app you can work in today. A desktop workbench is started in this repository. The terminal is how you use chivgent.

## Quick start

You need Node.js 22 or newer.

**1 · Install.**

```bash
npm install -g chivgent
```

Already installed? `chivgent update --check`, then `chivgent update`.

**2 · A key, or sign in when you get there.**

```bash
export OPENAI_API_KEY="your-api-key"
```

No key is fine. Run `chivgent`, type `/provider`, and enter one when asked. Keys are saved for your user only, in `~/.chivgent/auth.json`.

**3 · Ask, from the project.**

```bash
chivgent "Where is the entry point?"
```

The answer streams to stdout. Tool names appear on stderr. The project is unchanged.

```bash
chivgent --provider deepseek "Explain src/"        # DeepSeek, same shape of question
chivgent --allow-writes "Rename sayHi to greet"    # files change only with this flag
chivgent --allow-shell "Run the tests"             # a yes for each command, then the sandbox
chivgent --tui                                     # interactive, with a live region
chivgent --continue                                # the last session in this directory
```

In an interactive session, `/login oauth openai` or `/login oauth xai` signs in with a subscription. On a normal start, a key still wins. [Subscription sign-in](docs/subscription-oauth.md).

## How it fits together

You type in the terminal. chivgent calls the provider you picked. File tools stay inside the current directory. Shell, only if you turned it on, runs in a sandbox and does not receive your provider keys.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fit-dark.svg">
  <img src="docs/assets/fit-light.svg" width="920" alt="You, chivgent, the provider you picked, this directory, and a sandbox only if shell is on.">
</picture>

## What it can touch

| | Flag | What it can reach |
| --- | --- | --- |
| Read the project | default | This directory. Ignored, generated, and credential paths are skipped. |
| Change files | `--allow-writes` | Files inside the workspace. An edit has to match exactly, and it is written atomically. |
| Run a command | `--allow-shell` | Seatbelt on macOS, Docker elsewhere. Network is off. Each command needs a yes. |

You pay the provider you picked, at their prices. chivgent shows token counts. It does not turn them into money.

## Providers

| Provider | `--provider` | Key | Model |
| --- | --- | --- | --- |
| OpenAI, Responses API | `openai` (default) | `OPENAI_API_KEY` | `gpt-5.6` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| Any compatible endpoint | `openai-compatible` | `OPENAI_API_KEY` and `OPENAI_BASE_URL` | set `OPENAI_MODEL` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | set `OPENROUTER_MODEL` |
| Groq | `groq` | `GROQ_API_KEY` | set `GROQ_MODEL` |
| xAI | `xai` | `XAI_API_KEY` | set `XAI_MODEL` |
| Moonshot | `moonshot` | `MOONSHOT_API_KEY` | set `MOONSHOT_MODEL` |

`--model` overrides the model variable. Keys resolve in this order: `--api-key`, then the environment variable, then `~/.chivgent/auth.json`. A custom base URL receives your key and your prompts. Point it only at an endpoint you trust.

A compatible endpoint has to implement `POST /chat/completions` with tool calling. Changing the base URL is not a promise of full compatibility. [Architecture](docs/architecture.md#openai-compatible-providers).

## A session you can come back to

Run `chivgent` with no question for an interactive session. It is saved under `~/.chivgent/sessions`. `--continue` resumes the latest one in this directory. `/resume` lists the others, and only opens sessions from here.

`/plan` keeps the agent on read tools and a plan. Writes, shell, and extension tools stay blocked even if the model asks for them. `/compact` summarises older turns and keeps the full transcript for resume. `/status` shows the model, the permissions, and token use. `/help` lists the rest.

`--tui` adds a live status region and a multi-line editor. [TUI](docs/tui-v5.md). A long session stays inside the context window by summarising older turns, and keeping the list of files read and changed. [Context](docs/architecture.md#context-management).

## A desktop app is started

This repository also has an Electron app, aimed at a local workbench on the same agent: a project, a task, the work in front of you, the diff after. The current build is a prototype. It is not how you use chivgent today. [Desktop plan](docs/desktop-architecture.md).

## Boundaries

- Paths outside the workspace are rejected, including `..` and symlink escapes. Common credential paths are denied. Tool output is capped.
- `--allow-shell` asks before each command. A headless or served session denies commands unless you also pass `--approve-all-shell`. If the sandbox cannot start, the command does not run unsandboxed.
- The macOS sandbox can still read files your user can read. It contains writes and network. It is not confidentiality isolation. [Shell safety](docs/shell-sandbox.md).
- Extensions are JavaScript in the chivgent process. Trusting a project means letting its authors run code as you. chivgent asks once per directory, and does not load extensions when there is no terminal to ask.
- Keys, subscription credentials, and session logs are owner-only, and plain text. Logs contain prompts, answers, and file excerpts.
- `--serve` puts the session on a Unix socket in an owner-only directory. Anyone who can open the socket gets every capability the server started with. There is no TCP listener.

Work on committed code. Use a copy for a repository you do not trust.

## Documentation

| | |
| --- | --- |
| [Architecture](docs/architecture.md) | The loop, providers, context, and where the source lives |
| [Shell safety](docs/shell-sandbox.md) | Seatbelt, Docker, and what a command can still read |
| [Subscription sign-in](docs/subscription-oauth.md) | ChatGPT and xAI: what is stored, and what a key still does |
| [TUI](docs/tui-v5.md) | The live region, the editor, and diff review |
| [Evals](docs/evals.md) | Whether the agent finishes the task, separate from the unit tests |
| [Extensions and remote sessions](docs/extensions-and-remote.md) | Tools you add, and attaching another terminal |

## Development

```bash
git clone https://github.com/chivopic/chivgent.git
cd chivgent
npm install
npm test
```

Tests use scripted model clients and do not spend API credits. Issues and focused pull requests are welcome. Keep provider-specific types in `src/providers/`, so the agent does not depend on a vendor SDK.

## License

[MIT](LICENSE)
