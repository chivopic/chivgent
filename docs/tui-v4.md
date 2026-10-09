# TUI V4 — default inline composer and session history

Inspired by the separation of document, cursor, viewport, paste handling, and footer affordances in Codex's open-source TUI. chivgent uses its own lightweight terminal painter; this is **not** a copy of Codex's ratatui implementation.

## Default input behavior

With `chivgent --tui`, the cursor-addressable editor is now the **default** prompt. No `/editor` command is needed.

- **Enter** — submit the draft. **Ctrl+O** — insert a newline without submitting. **Ctrl+S** — alternate submit shortcut
- Arrow keys — move the caret. **Home/End**, **Ctrl+A/E** — line start/end. **Backspace/Delete** — grapheme-aware editing
- **Ctrl+Z** undo, **Ctrl+Y** redo, retaining the cursor at the corresponding prior edit (up to 100 snapshots)
- **Ctrl+R** reverse-search previously submitted prompts from the current session. Type a substring; Ctrl+R cycles matches; Enter loads the match as an editable draft. It does **not** submit it; press Enter again to send. Esc cancels search only.
- **Esc** or **Ctrl+C** discards the current draft but keeps the REPL open. **Ctrl+D** exits on an empty draft. A typing/paste limit of 64 KiB and 200 lines is enforced.
- Slash commands such as `/help`, `/model`, `/login`, `/review`, `/diff` are processed after submission. The existing readline-driven slash popup remains for legacy mode; it is not yet integrated as a full selectable popup in the default editor.
- Legacy `/compose` (line-by-line) and `/editor` (Enter newline/Ctrl+S send) remain available. When running `runRepl` directly without the `inlineComposer` opt-in, legacy readline behavior is unchanged.

The composer temporarily yields control to the existing readline API-key input and the explicit Docker Shell approval modal; the new editor does not receive secret keys or approval keystrokes.

## Compatibility / security

Only interactive `--tui` is changed, including `npm run demo:tui`. One-shot runs, `--json`, pipes, remote sessions, shell sandboxing, and tool grants retain their existing behavior. The history search is local to the current conversation/session, never fetched from an external service.

Review of **live git worktree changes** is not shipped in this phase. The existing `/review` viewer is limited to the last successfully applied patch. Running a host git subprocess as an implicit viewer would violate chivgent's deliberately explicit execution/approval boundary. A future design can use an approved, sandboxed read-only git tool.

## Verification

Unit tests cover undo and redo over grapheme-safe edits, redo invalidation, default Enter/Ctrl+O semantics, Ctrl+R recall, and Ctrl+D exit. Headless terminal tests exercise default input, slash commands, history and terminal cleanup. Existing terminal menu, API-key privacy and Shell approval regressions run in CI.

Future work: stable undo grouping for typing bursts, inline slash completions, Ctrl+Shift+Z mapping on terminals supporting key protocols, a safe authorized live Git diff, and mouse selection with explicit mouse reporting enabled only while editing.
