# TUI V5 — inline completion, mouse selection, approved Git review

chivgent's default terminal editor now follows three interaction principles found in the open-source Codex TUI: suggestions belong to the composer, mouse gestures are interpreted against a rendered viewport, and actual worktree inspection must be separate from the model's permissions.

## Inline slash menu

At the default `--tui` prompt type `/gi`. Up to five **registered** commands appear within the input region. Use ↑/↓ to choose and Tab to complete the command name, or Enter to complete a partially typed command (a second Enter sends). Escape dismisses the suggestions without discarding the draft. Ordinary prompts and unknown slash text are not silently converted to commands; only explicit submission invokes the existing command dispatcher. Extension command names are listed only when those extensions are loaded and trusted by the CLI.

## Mouse input

While the default TUI composer is open it temporarily enables SGR mouse tracking: click to move the caret, drag to select text, type/Backspace/Delete to replace the selection, and scroll the wheel to move between draft rows. Mouse hit testing uses grapheme-aware cell widths, not JavaScript code units.

To map **absolute terminal mouse coordinates** to an editor viewport safely, the terminal must respond to a standard cursor-position query. If it doesn't, the editor ignores click/drag instead of guessing a location; keyboard editing and wheel input remain usable. Selection is shown in reverse video on visible, non-truncated rows. Keyboard movement clears the mouse selection. All mouse modes are explicitly disabled when the composer closes so normal terminal selection resumes. No clipboard scraping, simulated OS mouse events, or general mouse access is involved.

## Real Git diff: opt-in, bounded, read-only

Use `/gitdiff` to inspect tracked unstaged changes; `/gitdiff --staged` to inspect staged changes. This is **not** the existing `/review`: that command still browses the last applied patch in the Agent's history.

Before reading the repository, the TUI displays the workspace path and asks for **one-time consent**. Only `y` starts a local Git process; `n` or Enter denies. chivgent runs a fixed-argument `git diff` directly, **not through a shell**, with no external diff, no textconv, disabled hooks/fsmonitor, no pager, no network, and bounded 256 KiB output / 7-second timeout. Only that exact read-only Git operation is permitted; this does not grant the AI permission to run Shell tools or change files.

Output is sanitized, then displayed in the existing terminal read-only patch viewer. Use arrows/n/p to page, q/Escape to exit. These commands do not stage, reset, checkout, commit or rewrite anything.

Important limits: Git diff of tracked paths excludes untracked files; `--staged` reflects the Git index, not the working copy; submodule contents are excluded; very large diffs return a bounded error. Repositories with unusual Git behavior should still be reviewed carefully using a trusted local Git client. A real Git diff may contain credentials accidentally present in modified files; only open it when you're comfortable displaying its content in the terminal.

## Verification

Regression tests cover prefix matching, Tab/arrow selection, Escape dismissal, Unicode hit testing, drag selection and replacement, terminal mouse mode cleanup, real staged vs unstaged changes, external-diff prevention, permission denial without invoking Git, and the approved read-only review flow.

This remains a lightweight native terminal UI, not a complete replication of Codex's fullscreen ratatui renderer or its mouse gesture/copy implementation.
