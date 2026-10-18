# From an issue to a reviewable pull request

This page is the order of work for a reported issue. [Code standards](code-standards.md)
is the acceptance bar: what a change must contain, what a test must prove, and how
a review is run. [Contributors](contributors.md) says what stops a review before it
starts. This page does not add rules; it puts the existing ones in the order they
are used.

An issue is a report about observable behavior. It is not an order to apply the
patch it suggests.

## 1. Restate the report as behavior

Write four lines before touching code:

- the trigger: the command, key, flag, or state;
- what happens today, with the exact output or exit code;
- what the issue asks to happen instead;
- how a test can observe the difference.

If those lines cannot be written, stop and ask. A report that only names an
implementation move ("move this function") is a suggestion, not a requirement.
The bug may be somewhere else.

Then find the page that owns the behavior in the table under
[documented behavior](code-standards.md#documented-behavior), read it, and check
its linked source. `docs/stage-*.md` and `docs/tui-v*.md` record history; they
are not the contract.

## 2. Decide whether the change is allowed

Stop and leave the decision to the maintainer when the issue asks to change a
deliberate decision: the read-only default, the fail-closed sandbox, the
process-local permission mode, or the split between shell cleanup and `--serve`
shutdown. The same applies to anything on the harm list in
[contributors](contributors.md#look-for-harm-first).

An issue that needs one of those changes can still be scoped and explained.
Implementing it is the maintainer's call.

## 3. Scope the change

One issue, one branch, one pull request. Split a behavior change from an
unrelated refactor, and split two issues that only share a file. An agent
proposes; it does not close a report, approve a change, or merge a branch.

Before writing code, name:

- the runtime path from user input to the end result, including the caller that
  consumes it;
- every sibling that shares the predicate: CLI, TUI, remote REPL, desktop host;
- the contract page that must be updated;
- the test file that will hold the failing test.

A change that touches more than one file gets a plan first. The plan states what
stays the same, not only what changes.

## 4. Reproduce, then lock the behavior

Reproduce on current `main` and keep the command and its output. Write the test
before the fix, run it against the old code, and confirm it fails because of the
issue's behavior. A missing import, a skipped test, or an empty fixture is not a
failure that locks anything.

Keep the test off the network and away from `~/.chivgent`, a live provider key,
and a running session's socket. Whatever the test starts, it stops.

## 5. Implement

Follow the rules in [code standards](code-standards.md#what-a-change-contains).
When a flag, exit code, permission mode, or async timing changes, re-derive
every caller and saved copy that assumed the old meaning. When a documented
behavior changes, update its owning page in the same change; do not copy the
fact into a second page and do not edit stage or TUI-version history.

Do not fold in nearby cleanup. If it is worth doing, it is another issue.

## 6. Verify and record the evidence

Run the checks that match the surface, not only the file that was edited:

| Surface | Check |
| --- | --- |
| Any change | `npm run check`, `npm test`, `npm run build` |
| CLI, providers, permissions, evals | `npm run eval -- --dry-run --allow-writes --allow-shell` |
| Shell sandbox or packaging | `node scripts/docker-smoke.mjs` on Node.js 22, `npm pack --dry-run` |
| `apps/desktop` | `npm run desktop:test`, `npm run desktop:build` |
| Release candidate | `npm run release:check` |

Also do the one check CI cannot do: put the old source back and run the new
test. Record its name and the real failure. Then restore the change and record
that it passes.

Run the real path where a terminal, platform, or account matters. What was not
tried is written as not tried; it is never described as working.

Write the same evidence in the commit body and in the pull request's Testing
section. A later review cannot see a chat.

## 7. Commit and open the pull request

Branch from current `main`, after fetching it. Keep the branch to the issue.

The commit subject names the area and the user-visible behavior. The body
records the verification from step 6, which test fails without the change, and
what was not run.

Open the pull request with [the repository template](../.github/pull_request_template.md).
Say `Closes #N` only when this change completes the issue; use `Refs #N` when it
is one part. Link the contract page, the implementation, and the evidence. A UI
change includes a screenshot or recording. When the environment cannot capture
one, say so and show the real rendered frame; do not present a mock-up as the
terminal.

Do not mix a second issue into the branch, and do not commit another session's
worktree.

## 8. Review, then stop

The maintainer pulls the head, merges it onto current `main`, and runs the
acceptance checks there. A reviewer breaks the fix on purpose and checks that
the new tests catch it. A push after the review starts a new review.

An agent answers comments with evidence. It does not approve, request changes on
its own authority, close the issue, or merge. The maintainer merges.

When a review finds the same miss again, add it to [LESSONS.md](../LESSONS.md)
with the date, the evidence, and the rule that would have caught it. After three
separate days it moves into the code standards.

## Stop conditions

Stop, and write the reason on the issue or pull request, when:

- the four-line behavior statement cannot be written;
- the change needs a deliberate decision or an item from the harm list;
- no test can fail without the change;
- landing the fix requires an unrelated refactor;
- the owning contract page and its source cannot be found;
- verifying it would require the real machine, a live credential, or a network
  call the issue does not cover.

"Blocked" is a finding. It is not a pass.
