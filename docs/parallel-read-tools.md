# P2-F: bounded parallel read tool scheduling

chivgent can overlap **consecutive built-in read-only tool calls** within one model response. This follows the useful Codex design idea (concurrent reads, exclusive mutating operations) without importing its whole runtime.

## Execution rules

- Parallel-safe tools: exact built-in instances of `read_file`, `list_files`, and `search_text`.
- Maximum concurrent reads: **4**. Longer sequences run in bounded waves.
- Exclusive tools: `write_file`, `edit_file`, `apply_patch`, `bash`, unknown tools, and **all** third-party extension tools, even if an extension uses a read-only-looking name. Subclasses overriding built-ins are also exclusive.
- A contiguous batch of reads finishes before any later exclusive call starts. The exclusive call finishes before any subsequent reads start.
- Tool results in the persisted transcript and next Provider request always retain the **original tool-call order**, regardless of completion timing. Real-time `tool_execution_end` events can arrive in completion order; each carries a stable `toolCallId`.
- If a parallel read aborts, chivgent waits for started reads to settle before emitting terminal `agent_end`. Successful reads remain in history; interrupted calls are explicitly marked as failed. There is no retry of side-effecting operations.
- Per-tool failures are returned to the model as isolated failed results, without discarding unrelated successful reads.

## Scope and limitations

This is deliberately more conservative than a general-purpose reader-writer lock. Rather than run independent reads *around* an exclusive operation, the scheduler only overlaps neighboring eligible calls, keeping the model's dependency/order semantics obvious. The fixed cap is not a performance guarantee.

The scheduler coordinates **tool calls within a single Agent turn**, not concurrent Agent sessions. The existing AgentSession single-prompt guard remains in place. Built-in readers must continue to be side-effect-free; adding a new built-in reader does not automatically grant parallel eligibility.

Tool implementations that ignore cancellation can delay terminal completion until they finish. This prevents dangling events or a persisted history claiming that a tool has finished when it is still running. This phase does not promise forced cancellation of arbitrary JavaScript extensions.

## How to verify

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

`tests/parallel-tools.test.ts` uses deferred test gates rather than timing-based speed assertions. It verifies concurrency, stable ordering even if the second read finishes first, read/write isolation, a cap of four, unknown extensions executing serially, independent failure handling, and aborted-batch draining.

No external model benchmark has been run in this phase. A real throughput or token-cost improvement should be claimed only after paired A/B runs on the same provider, model, and task suite under the P0-A reproducible baseline protocol.
