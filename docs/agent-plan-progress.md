# P3-A: Codex-inspired plan tracking in the Agent core

This feature studies the open-source Codex `update_plan` tool (`codex-rs/core/src/tools/handlers/plan.rs` and `plan_spec.rs`) and brings its **structured task progress** pattern into chivgent. It does **not** implement the separate Codex **Plan Mode**, which can impose different read-only permissions and user-approval semantics.

## What changes

A local CLI Agent now exposes `update_plan` in addition to file exploration and whatever write/Shell tools the user explicitly granted. For a genuinely multi-step task, the model can publish a checklist, report the active step, and mark steps completed as work is verified.

```json
{
  "explanation": "Inspection finished; implementing the scoped change.",
  "plan": [
    { "step": "Inspect relevant files", "status": "completed" },
    { "step": "Implement the fix", "status": "in_progress" },
    { "step": "Run tests and review results", "status": "pending" }
  ]
}
```

The schema is strict: one to eight unique steps, 160 characters per step, an optional 400-character explanation, only `pending`, `in_progress`, or `completed`, and at most one `in_progress` step. No unknown fields or terminal control characters. Invalid calls produce a normal tool error and **do not** publish a plan. A cancelled call also publishes nothing.

The Agent emits a serializable `plan_update` event when a valid plan is submitted. The TUI renders a persistent current-step summary during the run, and prints a short checklist to terminal scrollback after each update. Plan events flow through the existing session event pipeline and its event log.

## Important security distinction

A plan is a **communication and observability tool**—not authority. Updating a checklist cannot grant file writes, approve Shell commands, increase tool limits, or change the configured workspace. Successful status labels are what the model **reports**, not an independent claim that tests passed. Downstream benchmark graders must still examine actual results.

This first stage deliberately does not mutate the pre-existing evaluation tool fixture or evaluation baseline; the real CLI offers `update_plan`, while the established offline evaluation tool set remains frozen for apples-to-apples comparisons. The next experiment can explicitly opt into the tool for measured A/B runs.

## Next Codex features, in priority order

1. **Plan mode / execution mode separation**: planning is read-only, changes require an explicit execution transition, and no command or tool escapes the existing permissions.
2. **Checkpoint and recovery**: restore a known-good version of changed files after a failed attempt, without overwriting pre-existing user changes.
3. **Subagents for independent exploration**: bounded concurrency, separate context, explicit budgets and no extra tool privileges inherited unexpectedly.
4. **Skills and reusable instructions**: local opt-in task instructions loaded with transparent scope/precedence, never promoted above user/system authority.
5. **Richer execution telemetry and benchmarks**: collect evidence of tool reliability, task success, tokens and wall-clock latency against the frozen P0 baseline.

These are roadmap items, **not claims that they are already implemented**.

## How to verify

```bash
npm ci
npm run check
npm test
npm run build
npm run demo:tui
```

`tests/update-plan.test.ts` verifies input constraints, malformed plans, cancellation, the Agent's event ordering, complete tool result replay, and TUI rendering. A green CI run validates regressions, but does not establish quality or productivity improvements from an external model.
