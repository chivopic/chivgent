# Scoped AGENTS.md and Context Compaction (P1-E)

chivgent loads repository-specific coding conventions as **untrusted, lower-priority guidance**, separately from its trusted built-in system prompt. Repository files cannot grant permissions or override explicit user instructions and tool safety checks.

## How AGENTS.md is discovered

- On the first model request, read the workspace-root `AGENTS.md` if present.
- Prefer `AGENTS.override.md` when both exist in the **same** directory.
- After the Agent reads, lists, searches or edits a nested path, the next model request incorporates instructions from that directory and its ancestors, root-first. `apply_patch` supplies all referenced paths.
- A nested file's instructions apply to that subtree only. Unvisited sibling directories' instructions are not loaded.
- Do not traverse outside the chosen workspace, scan parent directories, follow symlinked guidance, or scan `.git`, `.ssh`, `.aws`.
- Each document is capped at 8 KiB and combined project text at 16 KiB. Oversized documents are visibly truncated.
- When applicable guidance changes, the Agent discards any Provider continuation that would replay stale server-side context.

This is **not** an exact Codex implementation. Codex may discover a project root using `.git` and has configurable fallback filenames. chivgent's current implementation explicitly limits discovery to its configured workspace root and supports only the two standard filenames.

**First-write guard:** If the model's first operation in a nested directory is a `write_file`, `edit_file` or `apply_patch` and it discovers previously unseen scoped guidance, chivgent **rejects that tool call before any write**. The next model request contains the newly discovered instructions; the agent can retry after reviewing them. Shell commands and third-party extension tools cannot be mapped safely to affected file paths and are not covered by this guard. For these tools, inspect the relevant directory first.

## Context compaction correctness

- Compaction preserves full conversation history in the session log; only the model-facing request is shortened.
- A tool call is counted as a read or mutation **only when its matching tool result succeeded**. Failed edits and interrupted tools are not marked as completed.
- A successful `apply_patch` contributes the paths it added, changed or deleted.
- Already remembered read/modified file lists survive subsequent compactions instead of disappearing when a prior summary replaces old tool history.
- Summarized prose and file lists are bounded, and project instructions are included in estimated token budgeting.
- File lists record successful tool activity, **not** an independently verified git diff. They are not proof that the final on-disk content matches the Agent's report.

## Quick example

```text
repo/
  AGENTS.md                 # applies to the repository
  src/
    AGENTS.md               # loaded after visiting src/, applies to src/
    api/
      AGENTS.override.md    # preferred inside src/api/
  docs/
    AGENTS.md               # not loaded by work limited to src/
```

Run chivgent normally; no additional CLI flags are needed. Unit and CI tests verify precedence, workspace boundaries, subdirectory discovery, provider-chain invalidation, successful file activity and summary reuse. Do not claim measured speed, token savings or improved benchmark scores without matching A/B evaluation runs.
