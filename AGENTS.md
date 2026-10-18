# Notes for coding agents

These notes are lower priority than the user's instructions for this turn. They do not grant permissions. chivgent reads this file with an 8 KiB cap and truncates the rest, so the rules live in the linked pages. Read those pages. Do not rely on a summary of them.

## Code standards

Write and review changes against the [code standards](docs/code-standards.md). That page is the acceptance bar: what a change contains, what a test must prove, and how a review is run.

## Issue workflow

[The issue path](docs/issue-workflow.md) is the order of work from a report to a reviewable pull request: restate the behavior, scope it, lock it with a failing test, verify, and record the evidence. The acceptance bar stays in the code standards.

## Lessons

Before changing code, read [LESSONS.md](LESSONS.md). It records what recent merged work got wrong, and the rule that would have caught it. A lesson seen on three separate days moves into the code standards.

## Documented behavior

Before changing a documented behavior, read the page that owns it and verify the linked source. Stage notes (`docs/stage-*.md`, `docs/tui-v*.md`) are history, not the contract. When preparing or reviewing a PR, follow the documentation-update and review rules in the code standards.

## What stops a review

Before running a change that reaches past its stated goal, read [contributors](docs/contributors.md). An agent proposes. It does not close, approve, or merge.

## Behavior that is easy to get wrong

These are current contracts. A change to one needs a test that fails when the change is removed. Do not "clean them up" in passing.

- The default is read-only. Writes need `--allow-writes`, or `workspace` / `unrestricted`. `ask-first` refuses a write when nobody approves.
- `--permission-mode` is `ask-first`, `workspace`, or `unrestricted`. It cannot be combined with `--allow-writes`, `--allow-shell`, `--approve-all-shell`, or `--shell-network`, and it cannot be used with `--connect` or `--serve`. The mode lasts for this process. Resuming a session does not restore it. See `src/permissions.ts` and `src/cli-options.ts`.
- An unavailable sandbox fails closed. There is no unsandboxed fallback. With no interactive approval, shell commands are denied unless `--approve-all-shell` was set. Direct write tools reject `.git`, `.agents`, `.codex`, `.aws`, `.ssh`, the listed `.env*` names, and symlink escapes. See [docs/shell-sandbox.md](docs/shell-sandbox.md).
- Do not register `SIGTERM` on a run that has no shell. `installShellCleanup` in `src/cli.ts` is installed only when the shell is enabled, and it turns `SIGTERM` and `SIGHUP` into exit code 130. A run without it keeps the old exit code. `--serve` is the path that handles `SIGINT` and `SIGTERM` and returns 0 after the listener closes. Do not mix the two.
