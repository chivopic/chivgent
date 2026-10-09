# TUI V2 — multiline composition, Markdown, paged Diff and approval keys

This iteration takes practical interaction ideas from Codex while retaining chivgent's native scrollback/readline design. It does not claim to reproduce Codex's fullscreen editor.

## Multiline prompt composition

Start interactive TUI mode and enter `/compose`:

```text
› /compose
Compose prompt · Enter adds a line · /send submits · /cancel discards
  │ Explain the following code:
  │
  │ async function main() {
  │   return await run();
  │ }
  │ /send
```

Each ordinary Enter inserts another line, including blank lines; readline still supports cursor editing on the current line. Pasting a multi-line block in one terminal input chunk preserves its line breaks (including CRLF), with a bounded 64 KiB buffer that refuses oversized pastes rather than silently submitting a partial draft. `/send` submits **one** multi-line user message, with newlines preserved. `/cancel` or Ctrl+C discards the draft without sending it; `//send` and `//cancel` enter literal command-looking lines. A draft is limited to 200 lines / 64 KiB. This explicit modal behavior avoids guessing whether terminal-specific Shift+Enter sequences mean a newline or submit. It is **not yet** a cursor-editable multi-row composer.

## Answer presentation

When stdout is a TTY, the TUI renders headings, bullet lists, block quotes and fenced code with clear indentation. Color is optional and disabled under `NO_COLOR` or `TERM=dumb`. ANSI/control bytes from model content are stripped before rendering, and each displayed line is bounded to the terminal's width.

When stdout is piped to a file/process, the final answer remains the exact Markdown text (no ANSI or terminal formatting). Plain/JSON CLI modes retain their prior output contracts. This is a small terminal formatter, **not** a full Markdown parser or syntax highlighter.

## Paginated patch review

`/diff` shows the latest **successful** `apply_patch` from the current session (including resumed history) with the full patch content split into pages. Use `/diff 2`, `/diff 3` and so on for subsequent pages. A page holds up to 28 lines. Failed patches cannot replace the last successful patch.

This review shows the **applied patch input**, not a fresh `git diff` from disk. A later file edit may have changed the files. It does not execute a pager or shell command; all output is sanitized and width-bounded. Use Git to review the actual current worktree before committing.

## Shell approval shortcuts

While an interactive Docker shell approval is displayed, press `y` to allow the shown command once; press `n` or Esc to deny it. Enter also denies by default; Ctrl+C cancels the run. No key grants session-wide approval. Commands that cannot be fully shown in the available terminal width remain blocked.

## Test coverage

- Real terminal emulator tests for multiline submit, literal slash lines, cancellation and returning to the prompt.
- Full patch history matching, pagination, missing/failed diff and terminal-control sanitization tests.
- Markdown layout, code fences, Unicode/narrow-width and stdout separation tests.
- Approval modal test for a single `y` key plus retained prior deny/cancellation checks.

No performance or real-user UX improvements are claimed without measurements.
