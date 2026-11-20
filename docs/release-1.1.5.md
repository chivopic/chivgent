# chivgent 1.1.5

This release guides users through their first model connection, simplifies the
terminal input area, and improves error reporting for workspace and web search.

## First model connection

- When a local interactive session needs configuration, **Connect a model**
  opens before the first prompt. DeepSeek is marked **Recommended**. OpenAI and
  xAI offer API key and subscription sign-in.
- The CLI can reuse a completed setup on restart. Run `/login` to open the
  connection flow again. See the [TUI controls](tui.md) and
  [subscription sign-in](subscription-oauth.md).

## Terminal interface

- The welcome screen adapts to terminal width. A single rounded composer
  handles multiline input and command completion. Use ↑ and ↓ to browse
  prompt history and return to your unsent draft.
- The terminal handles text selection and scrollback directly. The live view
  animates active work and keeps errors visible. See the
  [terminal interface](tui.md).

## Search

- Workspace search and listing report incomplete scans while keeping results
  from readable directories. `search_text` can match whole identifiers with
  `exact_identifier: true`. See [workspace discovery](architecture.md#workspace-discovery).
- Web search reports timeouts and cancellations during response-body reads.
  Search-enabled runs give the model the UTC date at the start of each run.
  See [web search](web-search.md).

## Desktop development preview

Desktop shows a DeepSeek connection form when no usable model configuration
exists. It validates new keys and saves them using system credential storage.
The npm package distributes the CLI. See [Desktop architecture](desktop-architecture.md).

## Upgrade

Node.js 22 or newer is required.

```sh
npm install -g chivgent@1.1.5
chivgent --version
```
