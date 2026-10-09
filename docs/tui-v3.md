# TUI V3 — cursor-addressable editor and interactive review

This phase was developed after reading the open-source Codex TUI's `bottom_pane/chat_composer/inline_input.rs`, `composer_layout.rs`, `paste_input.rs`, and its patch-approval rendering. The goal is to apply proven interaction principles, not copy Rust/ratatui source into chivgent.

## Editing a true multi-line prompt

Run `chivgent --tui` and type `/editor`. Unlike the older line-by-line `/compose`, V3 uses an independent in-memory document, grapheme-aware cursor, viewport, and painter. You can move back into earlier lines, insert/delete text in place and paste multiple lines without sending the prompt.

- **Enter** inserts a newline; **Ctrl+S** submits the draft as one prompt
- **Arrow keys** navigate characters or lines; **Home/End** or **Ctrl+A/E** jump to start/end of current line
- **Backspace/Delete** remove whole grapheme clusters (including joined emoji); **Esc** or **Ctrl+C** cancel without sending
- The editor redraws a maximum of eight content rows and keeps the caret in view, even after terminal resize
- Drafts are limited to 64 KiB / 200 lines; too-large inserts leave the document unchanged with a visible warning
- Input is routed exclusively to the editor while it is active: no prompt history, slash-menu or shell approval consumes its keystrokes

The older `/compose` mode remains available for compatibility. V3 does **not** claim full Codex editor parity: terminal-specific Shift+Enter, mouse selection, undo/redo, persistent draft recovery and historical search remain future work.

## Interactive patch review

Enter `/review` to inspect the last successful `apply_patch` in the current session:

- **Down / n / j / Space**: next page
- **Up / p / k**: previous page
- **q / Esc / Ctrl+C**: close and restore the normal REPL

It uses a read-only viewer with height-adaptive paging and width-bounded diff highlighting; no shell pager, network access, or filesystem mutation. The view shows the patch recorded when it was applied, **not** a live Git diff. Use `/diff [page]` for the previous non-interactive page output.

## Syntax highlighting

For recognized Markdown code fence languages—JavaScript, TypeScript, Python, Rust, Shell and JSON—the terminal renderer colors keywords, literals, strings and comments using a small local tokenizer. Unrecognized languages remain plain. All model text is sanitized before highlighting, and piped/JSON output remains unmodified.

## Tests and scope

Regression tests cover grapheme-aware edits, navigating back to earlier lines, bounded scroll viewport, Unicode/CRLF paste, Ctrl+S submission, Esc cancellation, terminal resize, return to readline, interactive patch paging, ANSI injection, and highlighting.

This is an incremental native-terminal implementation—not the Codex fullscreen ratatui UI—and has not undergone measured user-experience benchmarks.
