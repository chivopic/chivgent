# Evals and token usage

> Moved out of the top-level README in the README rewrite. Content unchanged unless noted.

## Evals

For a reproducible suite fingerprint and credential-free validation, see [the eval baseline guide](eval-baseline-guide.md). Run `npm run eval -- --dry-run --allow-writes --allow-shell` before recording model results. Missing token usage is reported as unknown, not zero.


The 300-odd unit tests check that the code runs the way it was written. They say
nothing about whether this is a good agent. `npm run eval` answers that:

```bash
npm run eval                              # every task in evals/
npm run eval -- --task rename-symbol --attempts 10
npm run eval -- --allow-writes --allow-shell --json report.json
DEEPSEEK_API_KEY=sk-... npm run eval -- --provider deepseek
```

`--api-key` works too, but prefer the environment variable here: npm echoes the
fully expanded command before running it, so a key on the command line lands in
the clear in any captured log.

```text
task                  pass  turns  tokens  tools                       p50
find-auth-logic       4/5   2.0    3.4k    list_files,search_text,...  6.1s
rename-symbol         3/5   5.4    12.1k   read_file,edit_file         9.8s

overall  7/10 (70%)  58.3k tokens

rename-symbol attempt 2,5: not-used-tool name="write_file" — called write_file 1 time(s)
```

The `tokens` column is what the Provider reported, so a change can be judged on
both axes at once: a prompt that lifts the pass rate from 70% to 75% while
tripling the tokens is usually a bad trade, and without the second number that
looks like a pure win.

**An eval is not a test.** A model is nondeterministic, so one run of a task is a
coin flip: passing and failing are properties of the model-and-harness
combination, not of that run. The unit is therefore a pass rate over N attempts,
and evals never gate CI — a merge gate that costs money and goes red six times in
ten trains everyone to ignore CI. `npm test` stays free, offline and
deterministic.

A task is a directory under `evals/`: a `task.json` and a `fixture/` tree copied
into a fresh temporary workspace for every attempt.

Tasks can opt in to the same automatic context compaction used by local
sessions by setting `contextWindow` in `task.json`, for example
`"contextWindow": 6000`. The eval runner then uses the task's Provider client
for both normal requests and summaries. Tasks without this field continue to
run without a `ContextManager`, so existing task results remain comparable.
Opt-in compaction attempts include `compactionCount` in their JSON report; the
count is omitted for other tasks. Keep long-session probes outside the default
suite unless they are deliberately added as benchmark tasks.

A task can opt into a bounded, multi-prompt conversation with `followUps`. The
runner sends each prompt through the same `AgentSession`, so later user
corrections see the transcript and any active compaction checkpoint. Set
`recoverAfter` to one-based prompt numbers to flush the session JSONL, close the
session, and restore it through the production `FileSessionStore` reader before
the next prompt. Both fields are optional; single-prompt tasks keep their
existing behavior and the default suite does not change. Recovery data stays in a
private temporary directory outside the model workspace and is removed when the
attempt ends.

```jsonc
{
  "prompt": "Read the archive record and inspect the index until ready.",
  "followUps": ["Correction: the current key is violet. What is it?"],
  "recoverAfter": [1],
  "contextWindow": 6000,
  "attempts": 3,
  "graders": [{ "type": "answer-matches", "pattern": "violet" }]
}
```

The cap is four follow-up prompts per task. Existing attempt and Agent-turn
limits apply to each task and prompt. Recovery points must be ordered, unique,
and fall after a prompt that has a later follow-up. Task-level graders
judge the final response and the accumulated attempt events/files. Evals report
the Provider-reported usage across every prompt and compaction call; when any
usage is missing, total usage remains incomplete/unknown. A fake-Provider test
proves the harness exercises repeated compaction and disk restore, but it does
not establish a real model's task success, constraint retention, latency, or
cost. Those comparisons require recorded runs on the named Provider/model.
An initial DeepSeek comparison and its limits are recorded in [the issue 121 eval note](eval-results/issue-121-deepseek-notes.md), with sanitized request-level measurements in its JSON companion. Keep that probe outside the default suite; its small sample does not support general reliability or cost conclusions.

```jsonc
{
  "prompt": "Rename the function sayHi to greet everywhere, including callers.",
  "capabilities": ["writes"],
  "attempts": 5,
  "graders": [
    { "type": "file-contains", "path": "src/greet.ts", "text": "export function greet(" },
    { "type": "file-excludes", "path": "src/greet.ts", "text": "sayHi" },
    { "type": "used-tool", "name": "edit_file" },
    { "type": "not-used-tool", "name": "write_file" }
  ]
}
```

Graders are deterministic — file contents, tool calls, answer patterns, turn
counts. There is no LLM judge: a judge is itself a nondeterministic instrument,
and measuring a nondeterministic subject with one compounds the error until "the
agent got worse" cannot be told apart from "the judge felt different today".

Those last two graders are the point. Rewriting the whole file also produces the
right contents, and an eval that scores results alone would give it full marks.
For a coding agent, tool misuse is the more common and the more interesting
failure, so tasks assert on how the work was done.

A grader naming a tool the task never grants is refused when the task loads.
`not-used-tool: write_file` on a read-only task cannot fail — it asserts the
model did not call something it was never given — and its mirror image cannot
pass. Both are task-definition mistakes, and both are caught before the run
spends anything. One such grader shipped for two releases before this check
existed.

Three graders exist because a set of tool names cannot answer the question they
answer. `tool-never-failed` catches a guessed path, which shows up as a failed
read that a deduplicated name list hides — it is sound only where a failed call
means the model was wrong, so it fits `read_file` and not `bash`, which reports
any non-zero exit as an error and is *supposed* to fail on a task that runs a
failing test. `max-tool-calls` budgets calls rather than turns, because a model
may issue any number of calls in one turn: "did it follow the imports or read
the whole project" is a call count. `file-unchanged` compares against the
fixture, so "don't touch what you weren't asked to touch" becomes a verdict
rather than an intention — and it needs no second copy of the file in
`task.json` to drift out of date. The JSON report carries `toolCalls`, every
call in order with whether it succeeded, alongside the `toolsUsed` set the table
prints.

The ten tasks split into what the agent found and what it changed. Four exist
because the first real baseline passed 29 of 30 attempts and therefore measured
nothing: `needle-in-many-files` (40 files with uninformative names, so listing
gives no signal), `trace-the-default` (a value overridden twice, where stopping
at the first hop yields a plausible wrong number), `decoy-config` (two
near-identical modules, one of them dead), and `wrong-test` (a failing test
whose expectation contradicts the contract documented in the source — bending
the source to fit it is the trap).

A task that scores 0/N or N/N across different models is not measuring anything
and should be made harder, fixed, or dropped. Passing is not evidence of quality
when everything passes.

## Token usage

Providers report what each call cost, and chivgent now keeps it: per turn on
`message_end`, per run on `agent_end` and the run result, per attempt in the
eval report, and cumulatively in `/session`.

```text
› /session
id:        2026-09-07T...
workspace: /home/me/project
prompts:   4
messages:  18
tokens:    38.2k total, 35.9k in, 2.3k out, 12.0k cached
```

**Tokens only, never money.** Converting to a currency needs a model-to-price
table, and that table goes stale silently when a Provider changes its rates —
producing a figure that looks precise and is wrong, which is worse than no
figure because nobody questions a number with a decimal point in it. Token
counts are what the Provider itself reported and do not expire.

A total is marked incomplete when some call reported nothing, rather than
counting it as zero: a missing figure stays visibly missing instead of quietly
understating the total. Compaction's own summarising call is included, since it
trades a call now against smaller inputs later and that trade cannot be judged
with half of it hidden.

Streamed Chat Completions only report usage when asked, so chivgent sends
`stream_options: { include_usage: true }`. A self-hosted OpenAI-compatible
endpoint that predates that field may reject the request; `--no-stream` is the
fallback.

