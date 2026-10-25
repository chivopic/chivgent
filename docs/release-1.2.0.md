# chivgent 1.2.0

This release adds structured questions in local interactive sessions and a way
to read truncated shell output. It also fixes shell approval handling, bounds
remote-client backlogs, and advances the Desktop development preview.

## Structured questions

- The built-in `question` tool collects single-choice, multiple-choice, or
  free-text answers in the local simple REPL and rich TUI, then continues the
  same run. Empty input is not treated as a default answer.
- Cancel a question with `/cancel` (or Esc in the rich TUI); Ctrl+C cancels the
  whole run. Answers collect requirements and never authorize writes, shell commands, or a
  permission change. Plan Mode can ask questions while retaining its tool
  restrictions.
- Headless, remote, and Desktop runs return an unavailable result immediately
  because they do not yet have a question presenter.

See [structured questions](architecture.md#structured-questions) and the
[TUI controls](tui.md).

## Shell output and approvals

- Truncated `bash` results can include a session-local Output ID. The new
  `read_shell_output` tool accepts that ID and a bounded line range, so the
  Agent can inspect saved output without reading an arbitrary filesystem path.
- Output reads return at most 200 lines or 32 KiB. Saved output has explicit
  complete, incomplete, or unavailable states; IDs expire after one hour of
  inactivity and are cleared when the session is cleared, replaced, or exits.
  Resuming a transcript does not restore old output IDs.
- The rich TUI preserves shell approval decisions through the permission gate.
  Unsafe or oversized command previews and previews invalidated by a terminal
  width change are refused before execution.

See [shell safety and output limits](shell-sandbox.md) for storage caps,
approval behavior, and platform restrictions.

## Runtime and remote reliability

- When asked which model it uses, the Agent reports chivgent and the currently
  configured Provider/model. Provider changes apply to subsequent requests;
  the answer describes configuration rather than proving the backend model.
- Remote sessions bound the send backlog for each client and disconnect slow
  consumers instead of buffering indefinitely. Encoding failures disconnect all
  attached clients rather than leaving them after a missing event. Input after
  connection shutdown is ignored, and server shutdown does not wait indefinitely
  for an unread client.

See [Agent identity](architecture.md#agent-instructions) and the
[remote connection contract](extensions-and-remote.md).

## Desktop development preview

- Session settings can save Provider, model, compatible endpoint, and API key
  in Desktop-local profiles. The profiles are separate from CLI credentials;
  existing environment and CLI credential precedence still applies.
- File changes support read-only, per-action approval, and workspace automatic
  write modes. Read-only remains the default, approval applies to a specific
  action, and Shell is not enabled in Desktop.
- The workspace review panel shows staged and unstaged diffs and bounded
  untracked text previews. These are workspace changes, including changes made
  outside the Agent.
- An explicit reconnect action restarts a failed host and reads saved history
  without resubmitting the run. Rejected starts retain the draft; accepted runs
  survive late invocation errors. Unfinished tools display an unknown result
  with their existing output retained. Prompt and model length limits are
  shown before submission, and an active run uses a square stop icon.

The Desktop app remains in development. This npm release distributes the CLI
and does not include a Desktop installer. See the
[Desktop architecture and current limits](desktop-architecture.md).

## Upgrade after publication

```sh
chivgent update --check
chivgent update
```

Or install explicitly with `npm install -g chivgent@1.2.0` after publication.
Node.js 22 or newer is required.

## Release preparation

The release gate is `npm run release:check`, covering type checking, automated
tests, a production build, and an npm package dry run. Follow the
[release workflow](releasing.md) to publish from `main` after the preparation
PR is reviewed and merged. The workflow creates the matching tag and GitHub
release only after npm publication succeeds.
