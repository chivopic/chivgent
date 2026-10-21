# chivgent 1.1.3

This release adds opt-in web search, strengthens long-session context
compaction, and improves the terminal workflow and Provider compatibility.

## Web search and shell approvals

- `--web-search URL` enables `web_search` through a SearXNG instance with its
  JSON API enabled. Search remains off unless a backend is configured.
- In `ask-first` and `workspace` modes, every search requires approval of the
  exact query. Denial, cancellation, or a missing approval channel sends no
  request. The optional backend token comes from `CHIVGENT_WEB_SEARCH_TOKEN`.
- With a permission mode selected, shell commands can request `scope: "network"`
  with a justification to ask for outbound network access while retaining
  workspace sandbox restrictions. Broad host access requires a separate
  `scope: "host"` approval and is available only on the macOS native backend.

See [web search](web-search.md) for backend setup, permission rules and bounds,
and [shell safety](shell-sandbox.md) for command scopes and platform limits.

## Long-session reliability

- Automatic and manual compaction check the summary request against the context
  budget before sending it. Oversized requests fail locally and preserve the
  transcript and any prior checkpoint.
- Empty summaries and cancelled results cannot replace a checkpoint. Reported
  usage from completed summary calls remains included even when the result is
  rejected.
- A summary can explicitly replace a superseded decision. Unfinished tasks
  remain pending until explicitly completed; more than 32 active pending tasks
  rejects compaction instead of silently dropping tasks.
- Eval tasks can opt in to automatic compaction with `contextWindow`; their
  JSON reports include `compactionCount`. Existing tasks keep their previous
  behavior unless they opt in. This adds evaluation support, not a new claim
  about model quality.

See [context management](architecture.md#context-management) and
[evals](evals.md) for the runtime and task configuration.

## Terminal and Provider improvements

- Completed lines of streamed answers move into terminal scrollback during the
  response, with Markdown formatting retained across streamed code blocks.
- The slash menu focuses on common commands. `/status` shows session details;
  `/diff` reviews workspace changes and `/diff patch` inspects the latest patch.
  Existing command aliases remain accepted.
- `/provider` opens an interactive Provider picker in the rich TUI. `/compose`
  and `/editor` explain the already-active multiline editor there. Enter sends
  the draft and Ctrl+O inserts a newline.
- The DeepSeek default changes from `deepseek-v4-flash` to `deepseek-flash`.
  An explicit `--model` or `DEEPSEEK_MODEL` still takes precedence.
- OpenAI-compatible requests omit `tools` when no tools are registered, avoiding
  gateways that reject an empty array. `message_end` events expose an optional
  `reportedModel` when supplied by the Provider; this is diagnostic metadata,
  not verification of the underlying model.
- Shared agent instructions clarify identity, task workflow, tool boundaries
  and evidence requirements for interactive sessions and evals.

See the [TUI guide](tui.md), [DeepSeek configuration](deepseek-provider.md), and
[Provider boundary](architecture.md#openai-compatible-providers).

## Desktop preview

Desktop development includes host shutdown and acceptance-test cleanup fixes,
plus guards against starting GUI acceptance runs on a shared desktop without an
explicit opt-in. The desktop app remains in development; this npm release
distributes the CLI and does not include a desktop installer. See the
[desktop architecture and current limits](desktop-architecture.md).

## Upgrade after publication

```sh
chivgent update --check
chivgent update
```

Or install explicitly with `npm install -g chivgent@1.1.3` after publication.
Node.js 22 or newer is required.

## Release preparation

The release gate is `npm run release:check`, covering type checking, automated
tests, a production build and an npm package dry run. Follow the
[release workflow](releasing.md) to publish from `main` after the preparation
PR is reviewed and merged. The workflow creates the matching tag and GitHub
release only after npm publication succeeds.
