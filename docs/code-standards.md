# Code standards

These rules are how a change is written and reviewed. They follow the layout of [yetone/magpie's code standards](https://github.com/yetone/magpie/blob/main/docs/code-standards.md) and the review steps in its [subsystem references](https://github.com/yetone/magpie/blob/main/docs/subsystems/README.md). The incidents named on those pages are magpie's. A repeat seen in this repository is recorded in [LESSONS.md](../LESSONS.md), and moves here after it has been seen on three separate days.

A reviewer checks each rule that applies. A PR that misses one gets a comment saying which. Comments, approvals, requests for changes, and merges wait for the maintainer. An agent drafts them.

## What a change contains

| Rule | What a reviewer looks at |
| --- | --- |
| A change does only what its goal needs. | Every change in behavior has a reason. Unrelated refactors, extra features, and policy changes go in a PR of their own. |
| A fix covers exactly the cases it means to. | Which cases change, and which neighboring ones stay the same. Different errors are not handled as one. |
| A change holds on the whole path. | Follow it from the user's input to the end result, through the callers, the state it changes, and the side effects. One correct function does not make the whole operation correct. Permission flags and `--permission-mode` are different paths. Shell cleanup and `--serve` shutdown are different paths. |
| A fix reaches every sibling of the bug. | Grep for the same pattern. CLI, TUI, remote REPL, and the desktop host are siblings when they share a predicate. So are the other branches of the same operation. |
| A change re-derives everything built on what it changes. | When a change alters a flag, a mode, an exit code, or the timing of an async step, find every caller, saved copy, and test that assumed the old meaning, and run it. |
| A failed read, parse, or hash means "unknown". | It never means "empty", "none", or "equal". Keep what was read before. A list that guards access fails closed when its file cannot be read. Test with the file unreadable. |
| Another app's values come from that app. | When this repository writes a provider request, an OAuth field, or another tool's config, take the type and value from that system's own data or docs, not from a field name that looks right. |
| A default never overrides a value the user set. | Before writing a key, list everywhere it is read. Test with a user-set value present. A saved session does not restore a permission mode, and a key still takes precedence over subscription sign-in on a normal startup. |
| Checks cover the edges the change touches. | For numbers, check the boundaries. For paths, check the platforms the change claims. For cancellation, check the aborted case. Pick checks by risk. |

## Tests

| Rule | What a reviewer looks at |
| --- | --- |
| A fix comes with a test that fails without it. | Put the old code back and run the new test. It must fail with a real failure that names the behavior. A compile error or a skipped test does not count. The PR says which test failed and what it failed with. This is the check [magpie#1258](https://github.com/yetone/magpie/pull/1258) failed: the new shutdown test stayed green after the drain was removed. |
| A test never reaches the network. | A vendor's page or API is served from a local fake, built from bytes saved from the real one. A package comes from the lock file, not a registry's latest. |
| Tests use real inputs. | Fixtures look like real requests, real serialized output, and real files on disk. That includes missing fields, empty values, and defaults. |
| Tests check behavior, not implementation. | Assert what the user or caller needs. A formatting change should not break a test, unless the exact bytes are the requirement. |
| A test that fails on `main` is a bug to fix now. | "Fails the same on origin/main" is not a baseline. Fix it at its cause, or open an issue naming the cause, before shipping on top of it. Do not call a failure a flake unless the rerun command and its result are written down. |
| Tests stay out of the real machine. | Never read or write `~/.chivgent`, a live provider key, or a running session's socket. |
| Whatever a test starts ends when the test does. | A child process, a Docker container, or a server a test starts is stopped before the test returns. |
| A timing test leaves room on both sides. | Do not bound a test by a wall-clock time a loaded runner can exceed. Reproduce a timing failure by injecting the delay, not by rerunning until it fails. |

## Acceptance criteria

A change is ready for review only when it shows each of the following that applies. Say which ones were run, at which commit, and what they printed. A check that was not run is listed as not run, never left out. The same record goes in the commit body, not only on the PR. A later review cannot see a chat.

1. **A test that fails without the change.** Put the old code back and run the new test. It must fail naming the behavior. Then restore the change and check the test passes. Say which test, and what it failed with.
2. **Tests off the real machine.** The run does not touch `~/.chivgent` or a live credential.
3. **The build and the suite.** `npm run check`, `npm test`, and `npm run build`. `npm test` does not include `apps/desktop` (`vitest.config.ts` excludes it). When the change is a shared predicate, run the suite, not only the file you think you touched.
4. **Desktop tests, when `apps/desktop` changes.** `npm run desktop:test`, `npm run desktop:build`, and the relevant offline Electron flow. CI's Desktop job runs unit/integration tests, the build, and both read-only and history Electron E2E flows under Xvfb; a local pass still records the exact platform and Node version.
5. **The check that matches the surface.** Eval preflight is `npm run eval -- --dry-run --allow-writes --allow-shell`. It does not call a model, and CI stops there. Docker sandbox smoke is `node scripts/docker-smoke.mjs`, and CI runs it only on Node.js 22. A release candidate also runs `npm run release:check`.
6. **Real use where possible.** A report about a platform is checked on that platform. There is no native Windows shell. A pass on macOS is not a Windows result, and it is not described as one. What was not tried is not told to users as working.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check`, `npm test`, `npm run build`, the eval dry-run, and `npm pack --dry-run` on Node.js 22 and 24. Docker smoke runs only on Node.js 22. Its separate Desktop job uses Node.js 22 to run `npm run desktop:test`, `npm run desktop:build`, and both offline Electron verification scripts under Xvfb; it uploads failure diagnostics for up to seven days. CI does not run a live/paid model eval or Desktop packaging/signing.

## Reviewing a PR

Pull the head, merge it onto current `main`, and run the acceptance checks on the result. Reading the diff is not a review. Then:

- **Break it on purpose.** Remove the fix, or break the code it guards in more than one way, and check that the new tests catch each break. A test that stays green had not locked the behavior.
- **Check the vendor, not the PR's account of it.** For a provider, an OAuth field, or another tool's config, read that system's own behavior. Try the change against it when a real check is possible, in a copy of the credentials, never against the live user config.
- **Follow the whole path.** A flag parsed in `src/cli-options.ts` still has to be honored in the tool that acts. An exit code changed in one signal handler is still wrong if another path exits differently.
- **Classify narrowly.** An error class covers only the case it describes.
- **A preview writes nothing.** A dry run or a default session has no side effects. `--allow-writes` and a permission mode are not implied by a review.
- **Don't reverse deliberate decisions.** The read-only default, fail-closed sandbox, process-local permission mode, and the split between shell cleanup and `--serve` shutdown are the maintainer's to change. A PR that changes one is left for the maintainer.
- **Docs match the source.** A reference is checked against the code it links, and every link must resolve.
- **Keep the PR to its goal.** Unrelated tests and refactors go in a PR of their own. Comments name functions, not line numbers.

The maintainer merges. When they ask an agent to merge, the merge names the commit that was reviewed: `gh pr merge --match-head-commit <reviewed sha>`. A push made during the review stops the merge. A head pushed after the review is reviewed again. Write on the PR what was run, at which head, before the merge.

## Documented behavior

This is the review contract from magpie's subsystem references, pointed at the pages this repository already has. Do not add a second copy of a fact.

Update the owning page in the same PR when a change alters a documented responsibility, interface, state transition, runtime path, compatibility rule, or failure behavior. An internal refactor that preserves the contract does not need a prose change. Keep each fact in one page and link to it.

| Contract | Page |
| --- | --- |
| How a turn is wired | [docs/architecture.md](architecture.md) |
| Permissions, sandbox, protected paths | [docs/shell-sandbox.md](shell-sandbox.md) |
| `AGENTS.md` discovery and compaction | [docs/scoped-agents-md.md](scoped-agents-md.md) |
| Subscription sign-in | [docs/subscription-oauth.md](subscription-oauth.md) |
| Patch application | [docs/apply-patch.md](apply-patch.md) |
| Extensions and remote sessions | [docs/extensions-and-remote.md](extensions-and-remote.md) |
| Desktop host | [docs/desktop-architecture.md](desktop-architecture.md) |
| What a user can run | [README.md](../README.md) |
| Release steps | [docs/releasing.md](releasing.md) |

`docs/stage-*.md` and `docs/tui-v*.md` record how the work was built. They are not the contract. Do not update them to "match" a behavior change.

For each affected contract, the PR explains the observable change with its trigger and before/after behavior. Link the page, the implementation, and the verification. State when a refactor preserves the documented behavior. That explanation is for a reviewer to check against the diff. It is not itself proof.

A reviewer then:

1. Identifies the affected contract and the actual runtime path.
2. Compares the claimed before/after behavior with the base and the head. Traces callers and state beyond the changed lines.
3. Checks that a changed contract appears in the owning page and that source links still resolve.
4. Checks that the cited tests exercise the claimed behavior. Reports checks that were not run.

A documentation update alone does not prove the implementation.

## Commits

A commit message names the area it changes, then says what the user now sees, as plain behavior. The body says how it was verified, which test fails without the change, and what was not run. That record is in the commit body. A review cannot recover it from a chat.

A checkout belongs to the session that made it. Do not commit from another session's worktree, and after committing check that `git show --stat HEAD` lists your files and only yours.
