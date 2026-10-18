<p align="center">
  <img src="docs/assets/chivgent-leaf-mark.png" width="88" alt="">
</p>

<div align="center">

# chivgent

### A coding agent in your terminal.

The same category as Claude Code and Codex. You bring the model.

[![npm](https://img.shields.io/npm/v/chivgent?color=111111)](https://www.npmjs.com/package/chivgent)
[![CI](https://img.shields.io/github/actions/workflow/status/chivopic/chivgent/ci.yml?label=CI&color=111111)](https://github.com/chivopic/chivgent/actions/workflows/ci.yml)
![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-111111)
[![License](https://img.shields.io/badge/license-MIT-111111)](LICENSE)

**[Website ↗](https://chivgent-web.vercel.app/)** · [Architecture](docs/architecture.md) · [Shell](docs/shell-sandbox.md) · [Sign in](docs/subscription-oauth.md) · **English** · [简体中文](README.zh-CN.md)

</div>

chivgent is a local agent for the directory you have open. The category is the one [Claude Code](https://code.claude.com) and [Codex](https://github.com/openai/codex) occupy: read the project, change it, run it, and come back to the session. The model is yours. An API key, or a ChatGPT or xAI subscription.

The default that category expects is auto mode. Ordinary reads, workspace edits, and sandboxed commands proceed. The agent stops when an action leaves the workspace, or when a command needs the host. Here that policy is `workspace`. It is not a second model reviewing each action, and it is not a bypass. This build does not start there. A session still opens read-only. Pass `--permission-mode workspace`, or the older flags.

## Getting started

You need Node.js 22 or newer.

```bash
npm install -g chivgent
```

Already installed? `chivgent update --check`, then `chivgent update`.

Start it in the project.

```bash
cd /path/to/project
chivgent
```

No key is required to open the session. Type `/provider` and enter one when asked, or export one first. Keys are saved for your user only, in `~/.chivgent/auth.json`.

```bash
export OPENAI_API_KEY="your-api-key"
```

In a session, `/login oauth openai` or `/login oauth xai` signs in with a subscription. On a normal start, a key still takes precedence. [Subscription sign-in](docs/subscription-oauth.md).

```bash
chivgent "Where is the entry point?"                     # reads, then answers
chivgent --permission-mode workspace "Run tests and fix them"
chivgent --permission-mode ask-first "Review this project"
chivgent --allow-writes "Rename sayHi to greet"         # older flag, not with a mode
chivgent --allow-shell "Run the tests"                  # asks, then Seatbelt or Docker
chivgent --provider deepseek "Explain src/"
chivgent --tui                                           # live region, multi-line editor
chivgent --continue                                      # last session in this directory
```

## Modes

| Mode | What proceeds | This build |
| --- | --- | --- |
| `workspace` | Workspace edits and sandboxed commands. Network stays off. A command that needs the host asks once, for that command only. | The auto-style default we want. Opt in with `--permission-mode workspace`. |
| `ask-first` | Reads. Each file change and each command asks. No answer means no action. | `--permission-mode ask-first` |
| `unrestricted` | Shell commands run with broad host file access and network, inside the OS sandbox. File tools stay in the workspace. | Explicit opt-in. |
| none | Reads. Writes and shell wait for a flag. Each command asks. | What `chivgent` does now. |

`--permission-mode` replaces the flags for this process. It cannot be combined with `--allow-writes`, `--allow-shell`, `--approve-all-shell`, or `--shell-network`, and it cannot be used with `--serve` or `--connect`. `/permissions` inspects or changes the mode, only in a session that started with one. The choice is not saved in the transcript. Resuming a session uses the mode you selected at startup, not a broader one from last time.

`/plan` is separate. It keeps the agent on read tools and a plan. Writes, shell, and extension tools stay blocked even if the model asks for them.

## How it fits together

You type in the terminal. chivgent calls the provider you picked. File tools stay inside the current directory. The shell runs in a sandbox and does not receive your provider keys. On the default start, the shell is off until you turn it on.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fit-dark.svg">
  <img src="docs/assets/fit-light.svg" width="920" alt="The default start: you, chivgent, the provider you picked, this directory, and a sandbox only if shell is on.">
</picture>

## What it can touch

This is the build, not the auto-style default above.

| | How | What it can reach |
| --- | --- | --- |
| Read the project | on | This directory. Ignored, generated, and credential paths are skipped. |
| Change files | `--allow-writes` | Files inside the workspace. An edit has to match exactly, and it is written atomically. |
| Run a command | `--allow-shell` | Seatbelt on macOS, Docker elsewhere. Network is off. Each command requires confirmation. |
| Pick a policy | `--permission-mode` | `ask-first`, `workspace`, or `unrestricted`. Replaces the flags for this process. |

You pay the provider you picked, at their prices. chivgent shows token counts; it does not convert them into costs.

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

A compatible endpoint must implement `POST /chat/completions` with tool calling. Changing the base URL does not guarantee full compatibility. [Architecture](docs/architecture.md#openai-compatible-providers).

## A session you can come back to

Run `chivgent` with no question for an interactive session. It is saved under `~/.chivgent/sessions`. `--continue` resumes the latest one in this directory. `/resume` lists the others, and only opens sessions from here.

`/compact` summarizes older turns and keeps the full transcript to resume later. `/status` shows the model, the permissions, and token usage. `/help` lists the rest.

`--tui` adds a live status region and a multi-line editor. [TUI](docs/tui-v5.md). A long session stays within the context window by summarizing older turns and keeping the list of files read and changed. [Context](docs/architecture.md#context-management).

## Boundaries

- Paths outside the workspace are rejected, including `..` and symlink escapes. Common credential paths are denied. Tool output is capped.
- With no mode selected, `--allow-shell` asks before each command. A headless or served session denies commands unless you also pass `--approve-all-shell`. If the sandbox cannot start, the command does not run unsandboxed.
- `workspace` runs workspace edits and sandboxed commands on its own, and asks once when a command wants host file and network access. `unrestricted` is the explicit opt-in for broad host access and network. Neither is saved with the session. [Shell safety](docs/shell-sandbox.md).
- The macOS sandbox can still read files your user can read. It restricts writes and network access. It is not confidentiality isolation.
- There is no per-command allowlist, and no native Windows shell. `workspace` is not the start mode of this build.
- Extensions are JavaScript in the chivgent process. Trusting a project means letting its authors run code as you. chivgent prompts once per directory, and does not load extensions when there is no terminal to prompt.
- Keys, subscription credentials, and session logs are owner-only and stored in plain text. Logs contain prompts, answers, and file excerpts.
- `--serve` puts the session on a Unix socket in an owner-only directory. Anyone who can open the socket gets every capability the server started with. There is no TCP listener.

Work on committed code. Use a copy for a repository you do not trust.

This repository also has an Electron app, aimed at a local workbench on the same agent. The current build is a prototype. It is not how you use chivgent today. [Desktop plan](docs/desktop-architecture.md).

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
