# Reproducible eval baselines

This workflow is the first step toward comparing chivgent with other coding-agent harnesses. A score is meaningful only when the **task bytes, model, provider, prompts, permissions and number of attempts** are comparable.

## 1. Validate the suite without spending API credits

```bash
npm ci
npm run eval -- --dry-run --allow-writes --allow-shell --json eval-preflight.json
```

This builds the CLI, validates the selected graders, fingerprints `task.json` and fixture contents, and records the Git commit and whether tracked files are modified. It **never constructs an API client or calls a model**.

The SHA-256 `suiteSha256` identifies the selected tasks and fixture bytes. Each task also has its own SHA-256. If either changes, do not compare results as though the benchmark were unchanged. An unknown Git revision is recorded as `null`, not guessed.

`attemptedTasks` and `skippedTasks` show which tasks are eligible under the supplied capabilities. A normal run refuses to start if none can run.

## 2. Capture the actual baseline

Run on a disposable checkout or isolated machine. `--allow-shell` is **not sandboxed by chivgent** at this stage: the eval model can run host commands. Do not grant shell access on a machine containing credentials or important files.

```bash
export OPENAI_API_KEY="your-key"
npm run eval -- --provider openai --model YOUR_MODEL --attempts 5 --allow-writes --json baseline.json
```

To include the tasks requiring shell, add `--allow-shell` **only in an isolated environment**. Do not place API keys in the command line. They can be captured by shell history and process listings.

The JSON report (schema version 2) contains the baseline manifest, pass rates with denominators, attempt status, ordered tool names/targets, duration, and reported token usage. When token usage is missing or incomplete, `totalTokens` is `null`; a missing measurement is **not** a zero-token run.

## 3. Make a fair A/B comparison

- Use the same `suiteSha256` and `promptSha256`, identical task eligibility, attempt count, provider and model. Record the chivgent Git revision and model version.
- Run each attempt from a fresh fixture; never reuse a modified workspace.
- Inspect *failures* and tool traces, not only aggregate pass rates. Separate `max_turns`, `aborted`, `error`, and completed-but-grader-failed attempts.
- Prefer 5–10 attempts per task for a quick signal; use more repetitions when differences are small. A small sample does **not** establish a statistically significant improvement.
- Do not present the September 2026 reports as directly comparable to this suite: the tasks, source revision and prompt behavior may differ.

The `rename-cross-module` task adds a small multi-file import/export refactor, preserving an unrelated plural-named helper and an untouched rounding module. It is a deterministic fixture, not a claim of SWE-bench equivalence.

## 4. Scope and limitations

The preflight checks suite validity and provenance. CI only runs the credential-free preflight and unit tests. CI never runs paid model evals and never supplies production API keys. The present runner uses deterministic graders and executes shell tools on the host when explicitly granted. Comparing chivgent *against Codex* on identical tasks will require a separate Codex execution adapter and matching sandbox/permission policies; this phase does not assert parity or a model pass rate.
