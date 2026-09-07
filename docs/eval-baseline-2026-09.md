# Eval baseline, September 2026 — DeepSeek

The suite ran. This document replaces the earlier one on this branch, which
recorded a blocked attempt and produced no measurement.

- Date: 2026-09-07
- Branch: `claude/progress-check-pqu8i6` at `625685b` (chivgent `0.15.0`)
- Provider `deepseek`, model `deepseek-v4-flash` — the registry default,
  `src/providers/definitions.ts:77`. The name resolves; no model-name error.
- Node `v22.22.2`, npm `10.9.7`
- 5 tasks x 3 attempts, run twice (30 attempts total)

## Bottom line

**29 of 30 attempts passed, and the single failure is a grader false negative,
not a model error.** On substance the model completed all 30 attempts
correctly.

That is a worse outcome than it sounds. A suite that a mid-tier flash model
saturates on the first real run is not measuring anything yet. **The headline
number to carry forward is not "93%" or "100%" — it is "the suite has no
headroom."** These five tasks can currently tell "works at all" from "broken";
they cannot tell one working model from another. Read the numbers below as a
smoke test that passed, not as a quality score.

## Results

Run 2 is the run of record and the one `baseline.json` in this commit
describes; it is the documented command, with the credential on `--api-key`.
Run 1 is the same command 4.5 hours earlier and is kept here because its one
failure is the most informative event in the whole exercise.

### Run 2 — `baseline.json` (2026-09-07T08:06:10Z)

```text
task                  pass  turns  tokens  tools                                       p50
find-auth-logic       3/3   3.3    3.8k    list_files,read_file,search_text            4.3s
fix-failing-test      3/3   5.0    10.9k   list_files,bash,read_file,edit_file         6.3s
no-hallucinated-read  3/3   3.0    4.0k    list_files,read_file                        4.9s
rename-symbol         3/3   4.0    7.6k    search_text,read_file,edit_file,list_files  5.5s
respect-line-endings  3/3   4.0    6.5k    list_files,read_file,edit_file,search_text  4.6s

overall  15/15 (100%)  100.3k tokens
```

### Run 1 (2026-09-07T03:42:49Z)

```text
task                  pass  turns  tokens  tools                                       p50
find-auth-logic       3/3   3.0    4.1k    list_files,search_text,read_file            4.5s
fix-failing-test      3/3   5.0    11.3k   list_files,read_file,edit_file,bash         7.0s
no-hallucinated-read  2/3   3.0    4.1k    list_files,search_text,read_file            5.8s
rename-symbol         3/3   4.3    8.0k    search_text,read_file,edit_file,list_files  6.4s
respect-line-endings  3/3   4.0    6.6k    list_files,read_file,edit_file,search_text  4.2s

overall  14/15 (93%)  102.7k tokens
```

Per task across both runs: `find-auth-logic` 6/6, `fix-failing-test` 6/6,
`rename-symbol` 6/6, `respect-line-endings` 6/6, `no-hallucinated-read` 5/6.
Overall 29/30 (97%).

## Where it failed, and why

One failure in 30. `no-hallucinated-read`, run 1, attempt 1:

```text
no-hallucinated-read attempt 1: answer-matches pattern="not exist|no such file|could not find|doesn't exist|does not exist|no .{0,20}file" — the answer did not match /not exist|no such file|could not find|doesn't exist|does not exist|no .{0,20}file/i: "There is no `src/database/migrations.ts` in this project — in fact, there is no `src/database/` directory at all.\n\nThe f"
```

The model was right. `evals/no-hallucinated-read/fixture/` contains exactly one
file, `src/index.ts`; there is no `src/database/`. The model refused the
premise and said so. It also passed the companion grader,
`answer-excludes "migration (runs|applies|executes)"` — it invented no
behaviour for the file it could not find.

It failed because it wrote *"There is no X"* and the pattern only accepts
*"does not exist" / "no such file" / "could not find" / "no ‹≤20 chars›file"*.
The phrase `there is no` is absent from the alternation, and `no .{0,20}file`
cannot bridge `` no `src/database/migrations.ts` `` (20 characters of path
before any "file", and `.` does not cross the newline).

So the task's own grader is what failed. Counted honestly, the model scored
6/6 on the hallucination task and the suite scored 5/6.

## Tool selection: what the traps actually caught

**Nothing. All three traps came back empty, and one of them cannot fire at
all.**

**Rewriting whole files instead of `edit_file` — genuinely clean.**
`write_file` was called 0 times in 30 attempts; `edit_file` was used in all 9
write-capable attempts per run. This is a real result for `rename-symbol` and
`fix-failing-test`, where `write_file` *is* registered and available
(`runner.ts:100`, capabilities include `writes`) and the model chose the
surgical tool anyway. `respect-line-endings` is the sharpest version — it
requires the file to come out byte-identical including CRLF endings, and it
passed 6/6.

**Hallucinating unread file contents — never happened.** 6/6 correct refusals,
as above.

**Guessing paths instead of using `search_text` — cannot be answered from this
data.** `search_text` appeared in 9/15 attempts (run 1) and 5/15 (run 2), and
every attempt used at least one discovery tool. But `baseline.json` stores
`toolsUsed` as a *deduplicated set of tool names* — no call order, no
arguments, no error flags. A model that guessed `src/auth.ts`, got an error,
then fell back to `list_files` records exactly the same `toolsUsed` as one that
listed first. `find-auth-logic` also has no grader on `search_text` at all.
The behaviour this suite was built to catch is the one it does not instrument.
See defect D3.

## Turns, latency, tokens

Turn counts are tight and identical in shape across both runs: 3–5 turns,
no attempt near its `maxTurns` ceiling (8/16/8/12/10). All 30 attempts ended
`status: "completed"`; none hit the turn limit, aborted, or errored.

Latency p50 per task 4.3–6.3s (run 2), full range 3.4–7.1s across both runs.
`fix-failing-test` is the slowest, which tracks — it is the only task that
shells out and the only one at 5 turns.

**The token column is populated and the numbers hold up.** This is the first
real-provider exercise of `src/providers/usage.ts`, so it was checked rather
than assumed:

- `complete` is `true` for all 30 attempts. No call reported nothing.
- `inputTokens + outputTokens == totalTokens` for all 30. No arithmetic drift.
- `cachedInputTokens <= inputTokens` for all 30.
- Magnitudes are sane: input 3.3k–10.9k, output 249–740, scaling with turn
  count. `fix-failing-test` carries the most context and shows the largest
  input, as it should.
- Cache-hit share of input is 89.5% (run 1) and 92.2% (run 2) — expected, since
  every attempt replays the same system prompt against DeepSeek's prefix cache.
- `reasoningTokens` is small but present (7–166), and correctly *absent* rather
  than `0` on the two attempts where the provider reported none. That is the
  "missing stays missing" behaviour `usage.ts` was written for, confirmed
  against a live provider.

Verified directly against the API, a `deepseek-v4-flash` `usage` object is:

```json
{
  "prompt_tokens": 85, "completion_tokens": 22, "total_tokens": 107,
  "prompt_tokens_details": { "cached_tokens": 0 },
  "completion_tokens_details": { "reasoning_tokens": 20 },
  "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 85
}
```

Token capture works. See D6 for one stale assumption it rests on.

## chivgent defects

Found while measuring, and deliberately **not** fixed — patching mid-measurement
would invalidate the numbers above. None of these are model failures.

**D1 — `no-hallucinated-read`'s answer pattern is too narrow.**
`evals/no-hallucinated-read/task.json`. It rejects "There is no X", the most
natural phrasing of the correct answer, and produced the only failure in 30
attempts. Adding `there is no|isn't any|is no such` would fix this instance,
but the deeper issue is that a regex over free-form prose is a brittle way to
grade a refusal. Highest-value fix here.

**D2 — `find-auth-logic`'s `not-used-tool: write_file` grader cannot fail.**
`runner.ts:100` builds the tool list from `task.capabilities`, and that task
declares `[]`, so `WriteFileTool` is never constructed. The grader asserts the
model didn't call a tool it was never given. It reads like a passing check and
is worth nothing. The equivalent graders on `rename-symbol` and
`fix-failing-test` are real, because those tasks do grant `writes`.

**D3 — the JSON report cannot evidence tool-selection quality.** `toolsUsed`
(`runner.ts:158`) is a deduplicated name set. Order, arguments, and per-call
error status are all dropped, so the report cannot show a guessed path, a
failed read followed by recovery, or a redundant re-read. Recording the ordered
call list with an error flag would make the path-guessing question answerable;
today it is not.

**D4 — the documented command prints the API key.** `npm run eval -- --api-key
sk-...` is what `README.md:501` and `docs/stage-11-evals.md:154` now recommend,
and npm echoes the fully-expanded command to stdout before running it —
verified, the key appears in the clear and lands in any captured log or CI
output. The env-var form (`DEEPSEEK_API_KEY=... npm run eval -- ...`) does not
leak. The docs should lead with the env var and note the flag's exposure.

**D5 — an empty `--api-key` is silently ignored.** `--api-key ""` does not
error; it falls through to the environment and then `auth.json`. A typo or an
unset shell variable therefore runs against *a different credential than the
one named on the command line*, with no warning. This bit this exercise
directly — see the caveat below.

**D6 — the DeepSeek cache fallback in `usage.ts` is dead for this model.** The
comment at `src/providers/usage.ts:35` says "DeepSeek reports cache hits at the
top level rather than in details", and the code reads
`prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens`. As the raw
response above shows, `deepseek-v4-flash` populates **both**, so the
first branch always wins and the top-level fallback never executes. Harmless
and defensive, but the stated premise is no longer true and the fallback is
untested in practice.

**D7 — `createClient` is documented as per-attempt but is not.**
`RunnerOptions.createClient` (`runner.ts:40`) is annotated "Built per attempt,
so a test can hand out a fresh fake each time", while `evals/cli.ts:122` passes
`() => llm` — one shared instance for every attempt of every task. Harmless
today: the non-streaming client holds only readonly config and takes history
per request, so attempts cannot leak into each other. It is a latent trap if
the client ever gains per-conversation state.

## How this was run

```bash
npm ci && npm run build
export DEEPSEEK_API_KEY=...            # not committed, not logged
npm run eval -- --provider deepseek --api-key "$DEEPSEEK_API_KEY" \
  --allow-writes --allow-shell --attempts 3 --json baseline.json
```

Smoke test first, which returned `ok`:

```bash
node dist/cli.js --provider deepseek --api-key "$DEEPSEEK_API_KEY" \
  --no-stream --no-session "reply with exactly: ok"
```

The `--api-key` fix on this branch works. Confirmed in isolation with the
environment variable explicitly unset, so the flag was the only credential
source; the run succeeded. With neither present the CLI gives its configuration
message rather than a table of zeros, as intended.

No task was skipped, no task hung, and nothing needed narrowing with `--task`.
The full suite takes about 80 seconds.

### Caveat on run 1's credential source

Run 1 was launched as `DEEPSEEK_API_KEY=... npm run eval -- --api-key "$DEEPSEEK_API_KEY" ...`.
The shell expands `"$DEEPSEEK_API_KEY"` *before* applying the prefix
assignment, so the flag received an empty string and, per D5, the credential
silently came from the environment instead. The run is valid — both are
sanctioned sources and the model saw an identical workload — but it did not
exercise the flag. Run 2 was re-run with the key genuinely on `--api-key`,
which is why it is the run of record.

## What this does not establish

- **n = 3 per task per run.** With 29/30 passing there is no variance to
  estimate; a task that fails 10% of the time would likely show 3/3 here.
- **One model, one provider, one afternoon.** No cross-model comparison, and
  no evidence about how any of this moves over time.
- **No cost figures.** Tokens are recorded; prices are not.
- **The ceiling is untested.** Every task is small — single-digit files, a
  one-line fix, a two-file rename. Nothing here probes multi-file reasoning,
  ambiguous instructions, or recovery from a bad first move.

The useful next step is not another baseline at these settings. It is harder
tasks, plus D1 and D3, so the suite can distinguish models rather than
confirm they are switched on.
