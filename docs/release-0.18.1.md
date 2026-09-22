# chivgent 0.18.1

This patch fixes input and rendering problems found while exercising the rolling
TUI introduced in 0.18.0.

## Fixes

- Submitting a line immediately blocks further input until the REPL is ready,
  preventing extra lines in the same input batch from queuing unintended runs.
- Long pasted text, including Chinese and split UTF-8 input, follows the normal
  readline editing path so wrapping and insertion at the cursor stay in sync.
- Ctrl+C at an idle TUI prompt clears the draft, including wrapped input.
- Ctrl+D on an empty TUI line clears the prompt before returning to the shell.
- Resizing to a very short terminal bounds the repaint to visible rows, keeping
  the new status on screen when older content has reflowed into scrollback.

Input remains single-line: only the first submitted line in an input batch is
accepted. Wait for the next prompt before sending another question.

## Runtime requirement

Node.js **22 or newer** is required. Package metadata and documentation now match
the requirement of the existing OpenAI SDK dependency. CI covers Node 22 and 24.

## Validation

- All 463 automated tests, type checking, build and package dry run passed.
- TUI and REPL regression tests passed on Node 22 and 24.
- New xterm-based tests inspect rendered terminal cells after cursor controls,
  including 80×24 → 32×12 / 16×5 → 120×40 resize cycles.
- A real macOS PTY verified batched and busy input, editing/history, cancellation,
  subsequent prompts and EOF cleanup using the offline demo.

Linux desktop terminal screenshots and real provider calls were not re-tested
for this patch. See [the TUI guide](tui.md) for controls and verification.
