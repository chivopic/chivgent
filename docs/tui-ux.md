# P2-G: Terminal UX design notes

This release borrows **interaction principles** from OpenAI Codex's open-source TUI, not its implementation, logos, or private assets. The goal is a calm, reliable coding surface that preserves native shell scrollback and doesn't obscure risky actions.

## Interaction hierarchy

1. **Quiet entry:** show product identity, current provider/model, workspace and one obvious next action. Avoid a giant ASCII banner and dense permanent panels.
2. **Active run:** keep a small live region with the last few answer lines, currently executing tools, elapsed time, turn count, completed/error counts and a visible Ctrl+C escape hatch. When more tools run than fit, show a count rather than scrolling the entire screen.
3. **Completed work:** render one bounded, scan-friendly record for each tool; group successful adjacent reads into a single line. Errors remain individually visible, including a short sanitized reason.
4. **Code changes:** a successful `apply_patch` shows file count, added/removed lines, per-file actions and up to four `+/-` code snippets; failed patches show an error **without** a misleading success summary. `edit_file` shows the size of the changed selection. This is a **change summary**, not a complete colorized diff viewer.
5. **Approval:** shell execution is a modal transition. Pause the status painter, show sandbox/network context and the complete exact command, then ask for affirmative `y`. Enter/anything else denies. If the entire command cannot be displayed or contains terminal controls, **refuse** approval rather than hiding a suffix.
6. **Accessibility / safety:** narrow terminals favor a visible cancellation shortcut over stats; strip control characters before applying any ANSI activity coloring; respect `NO_COLOR` and `TERM=dumb`. Rendered answers remain on stdout without styling while chrome and activity go to stderr. This is not a fullscreen alternate-screen application.

## Example scrollback

```text
  ◆ chivgent
  v1.0.0

  openai  ·  example-model
  /path/to/workspace

  Ready. Describe a task to begin.
  / commands  ·  Tab complete  ·  Ctrl+C stop/exit

  ✓ Explored 3 locations
  ✓ Patched
    3 files · +2/-1
    ~ src/a.ts (+1/-1)
    + src/b.ts (new file, +1)
    - src/deprecated.ts (deleted)
      -old
      +new
      +export const b = true;
  ✓ Shell npm test
    ↳ 42 tests passed

Completed · 3 turn(s) · 11s
```

When shell approval is required:

```text
  Shell command · Docker sandbox · network disabled
  ──────────────────────────────────────────
  │ npm test
  ──────────────────────────────────────────
  Approve once? [y/N]  ·  Enter deny  ·  Ctrl+C cancel
approve>
```

## Testing and constraints

Pure snapshot/layout tests cover multi-file patch summaries, failure state, escaped/control text, command review, counters, NO_COLOR behavior, Unicode widths and narrow terminals. A real xterm-headless integration test exercises the approval prompt, denied execution, painter suspension and re-entry to a working prompt. Previous live-region resizing and idle prompt tests remain in CI.

Things deliberately left out: alternate-screen takeover, mouse-driven widgets, Markdown syntax highlighting, live full unified-diff pagination, resumable approval overlays, fuzzy terminal width behavior, interactive Plan Mode and multi-line input composer. They merit separate designs and terminal-compatibility tests instead of being rushed into one high-risk PR.

To inspect the offline TUI without an API key:

```bash
npm ci
npm run demo:tui
```

UX correctness is tested; improvement in task success, terminal render latency, or approval error rate has not been measured with real users.
