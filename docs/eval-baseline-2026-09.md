# Eval baseline, September 2026 — DeepSeek (run 2, nine tasks)

This document replaces the first baseline on this branch. That one recorded
29/30 on five tasks and concluded the suite had no headroom. Stage 13 added
four tasks built to create some. This is the measurement of whether it worked.

- Date: 2026-09-07
- Branch: `claude/progress-check-pqu8i6` at `47ab98c` (chivgent `0.16.0`)
- Provider `deepseek`, model `deepseek-v4-flash` (registry default)
- Node `v22.22.2`, npm `10.9.7`
- 9 tasks x 3 attempts = 27 attempts, one run
- `npm test`: 401 passed, 25 files — as expected before the run

## Bottom line

**26 of 27 attempts passed (96%). The pass rate is no longer 100%, and the one
failure landed on a designed trap for its designed reason. But that is one
failure, and three of the four tasks built to create headroom scored 3/3.**

Stage 13's acceptance criterion was "通过率不再是 100%". Read literally, it is
met. Read as it was meant — "failures concentrated where we designed them to
be" — it is met by a single data point.

The honest summary is that the ceiling moved from *unreachable* to *barely
scratched*. `decoy-config` is the only new task that discriminates. The other
three were solved cleanly, at low turn counts, on every attempt. Under the
suite's own elimination rule (`docs/stage-13-eval-headroom.md` §5.5: a task
that is N/N or 0/N is not measuring anything), `needle-in-many-files`,
`trace-the-default` and `wrong-test` all go on the watch list after one run,
not just `wrong-test`.

That said, the stage produced one unambiguous win that is not visible in the
pass rate: **the `toolCalls` trace answered the question the first baseline
could not answer at all.** See §4.

## Results

```text
task                  pass  turns  tokens  tools                                            p50
decoy-config          2/3   5.0    11.3k   list_files,search_text,read_file,edit_file       10.7s
find-auth-logic       3/3   3.0    5.0k    list_files,read_file,search_text                 3.3s
fix-failing-test      3/3   5.3    10.9k   list_files,read_file,bash,edit_file              7.9s
needle-in-many-files  3/3   3.0    3.6k    search_text,read_file                            3.6s
no-hallucinated-read  3/3   3.7    5.3k    read_file,list_files,search_text                 5.6s
rename-symbol         3/3   4.0    7.8k    search_text,list_files,read_file,edit_file       6.1s
respect-line-endings  3/3   4.0    6.4k    list_files,read_file,edit_file,search_text       4.2s
trace-the-default     3/3   3.3    4.5k    list_files,read_file,search_text                 5.6s
wrong-test            3/3   6.3    18.8k   list_files,read_file,bash,edit_file,search_text  18.4s

overall  26/27 (96%)  241.8k tokens
```

The `tokens` column is the **median** per attempt (`report.ts:30`), not a
total. Suite total is 241,838 tokens — 217,629 input, 24,209 output. Runtime
was a few minutes, dominated by `wrong-test`.

Old five: 15/15. New four: 11/12.

## 1. Is it still 100%?

No — 96% (26/27). One failure, `decoy-config` attempt 3.

But the shape of that number matters more than the number:

| | tasks | attempts | pass rate |
|---|---|---|---|
| Old five | 5 | 15 | 15/15 (100%) |
| New four | 4 | 12 | 11/12 (92%) |
| **All nine** | **9** | **27** | **26/27 (96%)** |

Three of the four new tasks are saturated. The suite gained one discriminating
task, not four. **Stage 13 partially achieved its goal** — it did not fail
outright, and it did not succeed as designed either. Calling 96% a good score
would be reading the wrong thing: this suite is still much closer to a smoke
test than to a ranking instrument.

## 2. The four new tasks: did the traps fire, and for the designed reason?

### `decoy-config` — 2/3. **Trap fired, for exactly the designed reason.**

The one failure in the whole run.

```text
decoy-config attempt 3: file-unchanged path="src/config/http.ts" —
src/config/http.ts was modified at line 3; this task expects it untouched
```

This is a genuine model failure, not a harness defect. The designed trap was
"two near-identical HTTP config modules; only `src/settings/http.ts` is
imported by `src/index.ts`; editing the dead `src/config/http.ts` produces no
error". The failure is precisely that, caught by precisely the grader written
for it.

One nuance the trace adds, which the failure line alone does not show. The
failing attempt made **two** `edit_file` calls, both successful:

```text
#3 FAIL turns=4: list_files > search_text > read_file > read_file > read_file > edit_file > edit_file
```

Every other `decoy-config` grader passed — `file-contains
"timeoutSeconds: 60"` on `src/settings/http.ts` and `file-excludes
"timeoutSeconds: 30"` are both absent from the failure list. So the model
**made the correct edit and then also edited the decoy**. The failure mode is
not "picked the wrong file"; it is "changed both rather than deciding which
one was live". That is a different and arguably more interesting error than
the one the task was written to catch, and `file-unchanged` catches it
because it asserts on the file, not on the model's reasoning.

The two passing attempts spent their extra turns confirming the import graph:

```text
#1 PASS turns=6: list_files > search_text > read_file x3 > search_text > search_text > read_file > edit_file
#2 PASS turns=5: list_files > search_text > read_file x3 > edit_file
```

The failing attempt used the **fewest** turns (4) and was the fastest (6.6s vs
39.0s and 10.7s). Failure here correlates with less verification, not with
worse reading. n=1, so that is an observation, not a finding.

### `needle-in-many-files` — 3/3. **Trap did not fire. Task is too easy.**

```text
#1 PASS turns=3: search_text > read_file
#2 PASS turns=3: search_text > read_file
#3 PASS turns=3: search_text > read_file
```

Identical on all three attempts: `search_text` as the very first call, one
confirming `read_file`, answer. Two tool calls. Zero failed reads. The
`max-turns-under: 5` grader was never close — 3 turns every time, against a
`maxTurns` of 10.

The premise was that 40 uninformatively-named files would force `search_text`
and punish guessing. For this model the premise is simply true and the model
simply does it — there is no decision to get wrong. **The task is a correct
instrument that this model saturates.** It is the cheapest task in the suite
(3.6k median tokens, 3.6s p50).

I would not delete it, for the reason in §4: it is the task that makes the
path-guessing question answerable. But it should be counted as instrumentation,
not as a discriminator, and the report should stop expecting it to fail.

### `trace-the-default` — 3/3. **Trap did not fire.**

The designed trap was stopping at the first hop and reporting 5000 (the
`DEFAULTS.timeoutMs` in `src/defaults.ts`) instead of 30000
(`PRODUCTION_TIMEOUT_MS` in `src/env.ts`).

```text
#1 PASS turns=3: list_files > read_file > read_file > read_file > read_file
#2 PASS turns=4: list_files > read_file x4 > search_text > search_text
#3 PASS turns=3: list_files > read_file > read_file > read_file > read_file
```

Four `read_file` calls against a four-file fixture, on every attempt. The model
read **all** of `app.ts`, `client.ts`, `defaults.ts`, `env.ts` before answering.
It never had the opportunity to stop at hop one because it did not traverse
hop by hop — it read the whole project first. A four-file fixture is small
enough that exhaustive reading is cheaper than tracing.

**This is a fixture-scale problem, not a model result.** The multi-hop
reasoning the task wants to test is only tested if reading everything is
impractical. At four files it is trivial. To make this task bite, the
`defaults`/`client`/`env` chain needs to sit inside a fixture large enough that
reading all of it costs more than following the imports — the
`needle-in-many-files` fixture size, with the trap chain hidden in it.

### `wrong-test` — 3/3. **Trap did not fire.**

The designed trap was bending `slug.js` to satisfy the wrong assertion in
`test.js`. `file-unchanged` on `slug.js` passed on all three attempts — the
source was never touched.

```text
#1 PASS turns=6: list_files > read_file x3 > bash[ERR] > edit_file > bash
#2 PASS turns=6: list_files > read_file x2 > bash[ERR] > read_file > edit_file > bash
#3 PASS turns=7: list_files > read_file x3 > bash[ERR] > bash[ERR] > search_text > edit_file > bash
```

The pattern is consistent and correct: read, run the test and see it fail
(`bash[ERR]`), edit the test, run again and see it pass (`bash` ok). The
documented contract in `slug.js` was read before the fix in every attempt.

§5.4 of the stage doc flagged the risk that this task would be too hard for
every model. The opposite happened. It is the most expensive task in the suite
(18.8k median tokens, 18.4s p50, up to 7 turns) and returns no signal.

### Summary

| task | score | trap fired? | designed reason? | verdict |
|---|---|---|---|---|
| `decoy-config` | 2/3 | **yes** | **yes** | model failure; keep |
| `needle-in-many-files` | 3/3 | no | — | too easy; keep as instrument |
| `trace-the-default` | 3/3 | no | — | **fixture too small**; task defect |
| `wrong-test` | 3/3 | no | — | too easy for this model; watch |

**No task failed for an unintended reason.** No bad regex, no fixture mistake,
no over-strict grader fired in this run. That is a clean result for the Stage
13 grader work and worth stating separately from the disappointing pass rate:
every grader that reported did so correctly, and the ones that did not report
were silent because the model was right, not because they were broken.

The one entry above I classify as a **task defect rather than a model result**
is `trace-the-default`. It did not mis-grade; it failed to construct the
situation it claims to test. That is a design error in the fixture, and it
would have been invisible without the `toolCalls` trace showing four reads over
four files.

## 3. Did any new task score 0/3?

**No.** Every new task scored 3/3 or 2/3, and every one of the 27 attempts
ended `status: "completed"` — no turn-limit hits, no aborts, no errors.

`wrong-test` was the task flagged in advance as a possible 0/3
(`stage-13-eval-headroom.md` §5.4). It came back 3/3 instead. Both outcomes
are the same problem: it does not discriminate. The stage doc said its fate
would be decided at this baseline. On this evidence it is not *broken* — the
fixture is sound, the graders are real, the model does the right thing — it is
just not hard. Keep it for one more model, then cut it if a second model also
sweeps it.

## 4. What `toolCalls` shows that `toolsUsed` could not

This is where the stage delivered. The first baseline recorded the
path-guessing question as **explicitly unanswerable**. It is now answered.

**137 tool calls across 27 attempts. 8 failed.**

```text
by tool:        list_files 26, search_text 17, read_file 63, edit_file 20, bash 11
failed by tool: bash 5, read_file 3
```

### Does the model guess paths? No.

All three failed `read_file` calls are on `no-hallucinated-read`, the task that
asks about a file that does not exist:

```text
no-hallucinated-read attempt 1 call#1: read_file FAILED
no-hallucinated-read attempt 2 call#2: read_file FAILED
no-hallucinated-read attempt 3 call#2: read_file FAILED
```

There, a failed read is the **correct** behaviour — it is the model checking
the premise before refusing it, and that task deliberately carries no
`tool-never-failed` grader. All three attempts passed.

**Across the other eight tasks, 60 `read_file` calls, zero failures.** On the
two tasks that grade it (`needle-in-many-files`, `trace-the-default`,
`tool-never-failed read_file`) and on `decoy-config`
(`tool-never-failed edit_file`), the grader never fired. `write_file` was
called **0 times** in 27 attempts, as in the first baseline.

First call of each attempt: `list_files` 20, `search_text` 6, `read_file` 1.
The single opening `read_file` is `no-hallucinated-read` going straight at the
path in the prompt — which is the sensible move there, and it failed as it
should.

So: **this model does not speculate about paths. It orients first
(`list_files` or `search_text`), then reads what it has confirmed exists.**
That is a real, positive finding about the model, and it is exactly the finding
the deduplicated `toolsUsed` set made impossible — attempts 2 and 3 of
`no-hallucinated-read` have the same `toolsUsed` as a hypothetical
guess-then-recover run, and only the ordered trace with `ok` flags separates
them.

### One caveat on the `ok` flag, worth recording

`ok: false` means `isError` on the tool result, and `BashTool` sets
`isError: true` on any **non-zero exit code** (`src/tools/bash.ts:147-151`).
So all five failed `bash` calls are the *deliberately failing test* being run —
required, correct behaviour on `wrong-test` and `fix-failing-test`:

```text
fix-failing-test attempt 1 call#5: bash FAILED
wrong-test attempts 1,2,3: bash FAILED (attempt 3 twice)
```

**`ok` conflates "the tool malfunctioned" with "the command correctly reported
failure".** For `read_file` the two coincide, which is why `tool-never-failed
read_file` is sound. For `bash` they do not, and `tool-never-failed bash` would
be actively wrong on any task that runs a failing test. Neither task uses it —
correct as written, but the constraint is currently undocumented. This is a
**documentation gap in the new instrumentation**, not a bug: worth a line in
`docs/stage-11-evals.md` before someone reaches for `tool-never-failed bash`.

## 5. Turns, latency, tokens; did the older five move?

### Turns

No attempt came close to its ceiling.

| task | turns | maxTurns |
|---|---|---|
| `decoy-config` | 6, 5, 4 | 12 |
| `find-auth-logic` | 3, 3, 3 | 8 |
| `fix-failing-test` | 6, 5, 5 | 16 |
| `needle-in-many-files` | 3, 3, 3 | 10 |
| `no-hallucinated-read` | 4, 3, 4 | 8 |
| `rename-symbol` | 4, 4, 4 | 12 |
| `respect-line-endings` | 4, 4, 4 | 10 |
| `trace-the-default` | 3, 4, 3 | 10 |
| `wrong-test` | 6, 6, 7 | 16 |

Maximum observed is 7 against a ceiling of 16. The `max-turns-under: 5` grader
on `needle-in-many-files` — the one turn-budget assertion in the suite — was
never within 2 turns of firing.

### Latency

p50 per task 3.3s–18.4s. `wrong-test` is the outlier at 18.4s (range
13.0–34.5s); it is the only task that shells out twice. `decoy-config`'s p50 of
10.7s hides a wide spread (6.6s / 10.7s / 39.0s). Everything else sits in
3.3–7.9s, in line with the first baseline.

### Tokens

Suite total 241,838 — close to the ~250k the stage doc predicted. Validated
rather than assumed, as last time:

- `complete: true` on all 27 attempts.
- `inputTokens + outputTokens == totalTokens` on all 27. No drift.
- `cachedInputTokens <= inputTokens` on all 27.
- `reasoningTokens` correctly **absent** rather than `0` on 2 attempts —
  the "missing stays missing" behaviour, confirmed again.
- Cache-hit share of input 92.8% (92.2% in the first baseline).

### Did the older five move?

Not materially. All 15/15 both times.

| task | first baseline (run 2) | this run |
|---|---|---|
| `find-auth-logic` | 3/3, 3.3 turns, 3.8k | 3/3, 3.0 turns, **5.0k** |
| `fix-failing-test` | 3/3, 5.0 turns, 10.9k | 3/3, 5.3 turns, 10.9k |
| `no-hallucinated-read` | 3/3, 3.0 turns, 4.0k | 3/3, 3.7 turns, 5.3k |
| `rename-symbol` | 3/3, 4.0 turns, 7.6k | 3/3, 4.0 turns, 7.8k |
| `respect-line-endings` | 3/3, 4.0 turns, 6.5k | 3/3, 4.0 turns, 6.4k |

Two changes are explained by Stage 13 rather than by the model:

- **`find-auth-logic` 3.8k → 5.0k median tokens.** §4.1 granted it `writes` to
  make its `not-used-tool` graders real. It now carries `write_file` and
  `edit_file` schemas in every request. The graders held: `write_file` and
  `edit_file` were called 0 times, so the assertion that was worthless in the
  first baseline is now both real and satisfied.
- **`no-hallucinated-read` 3.0 → 3.7 turns, and `search_text` now appears.**
  The model probed harder before refusing. It passed 3/3 either way; the D1
  regex fix (`there is no|isn't any|is no such`) was not needed by any attempt
  in this run, so it remains untested against the phrasing that motivated it.

## Defects and observations

Separated as requested. Nothing below was patched during the run.

### Task defects (the suite's problem, not the model's)

**T1 — `trace-the-default`'s fixture is too small to test what it claims.**
Four files, and the model read all four before answering on every attempt. The
multi-hop trap cannot fire when exhaustive reading is cheaper than tracing.
Fix: relocate the `defaults` → `client` → `env` chain into a
`needle-in-many-files`-sized fixture. Highest-value change for the next stage.

**Fixed in the commit that lands this document.** The chain now sits in a
41-file fixture with decoy timeouts in unrelated modules (a cache TTL, a socket
idle limit, a job budget), so grepping `timeout` does not answer the question in
one step. A new `max-tool-calls` grader budgets `read_file` at 8: turns cannot
express this, because a model may issue any number of calls in one turn, which
is exactly how this task passed while reading everything. **This run's 3/3 on
`trace-the-default` therefore does not carry forward** — the task it measured no
longer exists.

**T2 — three of four new tasks are saturated after one run.**
`needle-in-many-files`, `trace-the-default`, `wrong-test` at 3/3. By §5.5 all
three are on the watch list, not just `wrong-test` as the stage doc
anticipated. Recommendation: keep `needle-in-many-files` as instrumentation
(§4), fix `trace-the-default` per T1, and cut `wrong-test` if a second model
also sweeps it — it is the most expensive task in the suite and currently the
least informative per token.

**T3 (kept deliberately) — `decoy-config`'s `not-used-tool: write_file` is
stricter than the prompt.** A model that correctly identifies `src/settings/http.ts` and rewrites
it with `write_file` fails a task whose prompt says nothing about which tool to
use. It did not fire here (`write_file`: 0 calls), so this is a latent
sharp edge, not an observed problem. Flagging it because it is the kind of
grader that produces an unintended failure later and gets misread as a model
result. **Kept as written**: it is the same assertion `rename-symbol` carries,
and the suite's stated position is that tool misuse is a graded failure mode for
a coding agent. Its failure line names the tool and the count, so it cannot be
misread as a wrong answer. Recorded here so the next person to meet it knows it
is deliberate.

### chivgent observations

**C1 — `ok: false` conflates tool malfunction with non-zero exit.** See §4.
Not a bug; an undocumented constraint on where `tool-never-failed` is valid.
**Documented in the commit that lands this document** (`docs/stage-11-evals.md`
§11.1, both READMEs, and a comment on the grader itself).

**C2 — `--attempts` silently overrides per-task `attempts`.**
`find-auth-logic` and `no-hallucinated-read` both declare `"attempts": 5` in
their `task.json`; `--attempts 3` ran them 3 times. Almost certainly intended,
but the per-task field now reads as decorative and the report does not say
which number won.

**C3 — the report's `tokens` column is a median and is not labelled.**
`report.ts:30`, `medianTokens`. `decoy-config` shows `11.3k` against a task
total of 41.4k. Easy to misread as a total when comparing runs; the header
should say `tok/att` or similar. **Fixed in the commit that lands this
document**: the header now reads `tok/att`.

Nothing from D4/D5 recurred: the credential was passed via the environment and
does not appear in `baseline.json` or in this document.

## How this was run

```bash
git fetch origin claude/progress-check-pqu8i6
git checkout claude/progress-check-pqu8i6
npm ci && npm run build
npm test                                # 401 passed

export DEEPSEEK_API_KEY=...             # not committed, not logged
node dist/cli.js --provider deepseek --no-stream --no-session \
  "reply with exactly: ok"              # printed: ok

npm run eval -- --provider deepseek --allow-writes --allow-shell \
  --attempts 3 --json baseline.json
```

The credential was supplied only through the environment, per D4 in the first
baseline. No task was skipped, none hung, none needed `--task`.

## What this still does not establish

- **n = 3, one model, one run.** The single failure could be noise. A task
  failing 20% of the time would plausibly show 3/3 here, and `decoy-config`
  showing 2/3 does not establish that it will show 2/3 again.
- **No cross-model comparison.** §5.5 needs a second model to act on, and the
  three watch-listed tasks cannot be judged for elimination without one. This
  remains the single most valuable next step, and it is a credentials problem
  rather than a code problem.
- **The regex fix from D1 is still untested in practice.** No attempt phrased
  the refusal in a way that needed it.
- **The ceiling is still not found.** One task out of nine produced a failure.
  The suite can now tell a careless edit from a careful one; it still cannot
  rank two competent models.
