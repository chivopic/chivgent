# apply_patch: multi-file structured edits

`apply_patch` is exposed only when chivgent starts with `--allow-writes`. It is designed for small, exact edits to several files in one call. It runs through the same workspace path checks as `write_file` and `edit_file`; it **does not** run a shell or require Docker.

## Example

```text
*** Begin Patch
*** Update File: src/greeting.ts
@@
-export const greeting = "Hello";
+export const greeting = "Welcome";
*** Add File: src/new.ts
+export const enabled = true;
*** Delete File: src/deprecated.ts
*** End Patch
```

The model sends the entire text as the `patch` property of the tool arguments. For `Update File`, each `@@` block contains lines prefixed with a space (unchanged context), `-` (removed), or `+` (added). Context must match **exactly once** in the target file. If it is ambiguous, include more surrounding lines. Several `@@` blocks per file are supported.

**Supported in P1-D:** adding new files (never overwrites an existing file), updating multiple text files, deleting existing files, strict hunk matching, preserving uniform CRLF/BOM on updates, file size limits, workspace path and symlink checks, duplicate target detection, full preflight before writes and best-effort rollback if a later write fails.

**Not yet supported:** `*** Move to:`, fuzzy whitespace matching, freeform/unified git diffs, binary files, `@@ function name` hint syntax, `*** End of File` marker, or full multi-file filesystem atomicity. This is intentionally a strict subset of the Codex patch language, **not** a byte-compatible implementation.

## Safety and recovery

The engine validates all parsed file changes before touching any target. If *any* hunk does not match, no file is modified. During commit each file is checked again; each replacement uses an atomic rename, and earlier committed changes are rolled back on a later error. A crash, abrupt signal or a concurrent writer may still cause partial or conflicting changes. If rollback fails the tool explicitly reports affected paths for manual inspection.

As with all write-enabled tools, a patch can change files within the permitted workspace. Only run against a trusted or disposable worktree and review the resulting diff.

This phase is validated by deterministic tests; there are **no claimed improvements in model eval scores** until the benchmark is rerun under comparable conditions.
