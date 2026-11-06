# Issue 121: DeepSeek long-session probe

This is a small exploratory comparison of the existing text-summary compaction
path. It does not decide whether compaction is sufficient for all long
conversations, and it does not establish a benefit from native provider
compaction or historical retrieval. The measured comparison has two 6,000-window
attempts and three 32,000-window attempts; a separate 6,000-window pilot is
reported on its own and is excluded from that comparison.

On 2026-10-25, the same three-prompt task and fixture were run with a local
`contextWindow` heuristic of 6,000 and 32,000, using `deepseek-flash`. The
6,000-window group passed 1/2 measured attempts; one attempt completed after 5
compactions in 34,959 ms and reported 48,073 tokens, while the other failed
with `Request timed out.` after 543,707 ms, 2 compactions, and partial usage of
19,445 tokens. Because one attempt had incomplete usage, the 6,000-window
aggregate is unknown (`null`); 67,518 reported tokens is only a lower bound.
The 32,000-window group passed 3/3, had no compactions, and reported 181,819
total tokens. Durations were 11,455, 12,820, and 12,725 ms. An earlier 6,000
pilot passed 1/1 after 5 compactions, 11 agent turns, 51,213 reported tokens,
and 59,174 ms; it is separate from the measured 2-attempt group.

The measured comparison is descriptive, not evidence that the small window
saves cost or that the larger window is more reliable. It has two small-window
attempts and three control attempts, including one small-window timeout with
unusually high latency; the separate successful pilot does not increase the
measured small-window sample. Window size changes both summary frequency and
the requests sent to the model.
The harness requested at most 4,096 output tokens per call, disabled SDK
retries, and configured a 90-second request timeout; the observed 543,707 ms
attempt shows that this was not a strict end-to-end latency bound. Provider
usage included reasoning tokens. The `contextWindow` values and the local
character-based estimate are harness heuristics; they are not DeepSeek's
vendor context limit or tokenizer.

Keep the current text-summary path as the default while collecting broader
results. This probe does not justify native compaction or history retrieval;
those remain separate research questions. Repeat with more attempts and task
families before making a reliability or cost claim. In particular, compare
success on the early archive fact and corrected route, instruction/constraint
retention, compaction count, latency, complete provider-reported total tokens
(including summary calls), and recovery behavior. Never convert missing usage
to zero.

The sanitized machine-readable request and attempt measurements are in
[`issue-121-deepseek.json`](issue-121-deepseek.json). It preserves suite and
prompt fingerprints and the original revision/dirty flags. The runs used a dirty
candidate tree whose exact patch/tree was not preserved; the failed in-flight
turn-count fix was added afterward, so these real-model measurements were not
made against the final source tree. The artifact contains no credentials,
request content, or response content. The original temporary reports and logs
are not required to interpret it.

To repeat the probe without adding it to the default suite, build first and run
the portable opt-in script from the repository root:

```sh
npm run build
node evals-long-session/run-deepseek.mjs --dry-run --context-window 6000
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" node evals-long-session/run-deepseek.mjs --context-window 6000 --attempts 3 --report /tmp/issue-121-small.json
```

For a 32,000-window control, run the same task and fixture with
`--context-window 32000` and a separate report path. The script accepts
`--task-root` when using a copied fixture. It stores only the eval report and
request-level HTTP metrics, never prompt/response content or credentials. Keep
the generated baseline manifest with each report so the exact fixture, prompt,
source revision, and settings remain identifiable. A repeat can yield different
model behavior and token usage.
