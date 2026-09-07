# Eval baseline attempt, September 2026 — blocked, no baseline produced

> **Outcome: no baseline was produced.** The eval suite was never run against
> DeepSeek. This document records why, what was proven, and what remains
> unknown. It is deliberately *not* a results table: there are no results to
> report, and publishing a table of zeros would misrepresent a missing
> credential as a model failure.

- Date: 2026-09-07
- Repository commit: `1b70216`, chivgent `0.15.0`
- Node `v22.22.2`, npm `10.9.7`
- Intended target: provider `deepseek`, model `deepseek-v4-flash` (the
  registry default, `src/providers/definitions.ts:77`)

## Bottom line

Two independent blockers stopped the run. Either one alone would have been
fatal:

1. **No DeepSeek credential is reachable from this environment.** The run was
   expected to work by having the agent proxy attach an `Authorization` header
   after requests leave the VM. It does not do that. Proven three ways below.
2. **`npm run eval` does not accept `--api-key`.** The documented command for
   this exercise fails at argument parsing, before any network call. This is a
   chivgent defect, not an environment problem, and it would have blocked the
   run even with a working credential.

## What was run

### 1. Install and build — passed

```
npm ci        # 50 packages, 0 vulnerabilities
npm run build # tsc, clean
```

### 2. Offline test suite — passed

```
npm test
# Test Files  25 passed (25)
# Tests       379 passed (379)
```

The harness is healthy. Nothing below is caused by a broken checkout.

### 3. Connectivity smoke test — failed (401)

```
node dist/cli.js --provider deepseek --api-key placeholder --no-stream --no-session "reply with exactly: ok"
```

```
Agent failed: 401 Authentication Fails, Your api key: ****lder is invalid
```

Per the run instructions, a 401 here means the credential is not attached, and
the paid suite was not started. Diagnosis follows.

## Blocker 1: the credential is not attached

Three independent checks, all agreeing.

**a. chivgent's own placeholder arrives at DeepSeek unmodified.** The 401 body
echoes the last four characters of the key it received: `****lder` — the tail of
the literal string `placeholder`. If the proxy were substituting a real
credential after the request left the VM, DeepSeek would not have seen our
placeholder at all.

**b. A request with no `Authorization` header at all is also rejected.**

```
curl -X POST https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
# HTTP 401 — Authentication Fails (governor)
```

Nothing is being injected on the way out. Had a credential been attached, this
unauthenticated request would have succeeded.

**c. The proxy reports no credential feature and no denials.**
`curl -sS "$HTTPS_PROXY/__agentproxy/status"` returns `selective: false`,
`toolScoped: false`, and `recentRelayFailures: []`. `/root/.ccr/README.md`
documents TLS trust, git rewriting, and egress policy — it describes no
credential-injection mechanism.

**Network egress itself is fine.** `api.deepseek.com` is reachable and answers;
the 401s are DeepSeek's own responses (its structured JSON error body), not a
proxy `403`/`407`. The host is not blocked. The credential simply does not
exist in this session.

No `DEEPSEEK_API_KEY` was present in the environment, which the run
instructions anticipated. Per those instructions, no search for a real key was
made and none is being requested here.

## Blocker 2: the eval runner rejects `--api-key`

The command specified for this exercise:

```
npm run eval -- --provider deepseek --api-key placeholder --allow-writes --allow-shell --attempts 3 --json baseline.json
```

fails immediately:

```
Unknown option: --api-key
```

This is not a credential problem — it is argument parsing, and it happens
before any network call. **This command could never have worked**, with or
without a valid key. See the defects section below.

Routing the same placeholder through the only channel the eval CLI accepts (the
environment variable) gets past parsing and reaches the network, where it hits
the same wall as blocker 1:

```
DEEPSEEK_API_KEY=placeholder node dist/evals/cli.js --provider deepseek \
  --allow-writes --allow-shell --task find-auth-logic --attempts 1
```

```
task             pass  turns  tokens  tools  p50
find-auth-logic  0/1   0.0    -              0.5s

overall  0/1 (0%)

find-auth-logic attempt 1: run ended as error: 401 Authentication Fails, Your api key: ****lder is invalid
find-auth-logic attempt 1: answer-matches pattern="auth/session\.ts" — the answer did not match ...
find-auth-logic attempt 1: used-tool name="read_file" — never called read_file; called nothing
```

The full 15-run suite was not executed. With no credential it would have
produced fifteen identical copies of the line above: no information about
DeepSeek, and a `baseline.json` whose `0%` would invite exactly the wrong
conclusion.

## What *is* known good

The blockers are upstream of the agent, so this attempt still confirms a few
things about the harness:

- The eval runner resolves credentials through the shared chain and reports a
  provider error using the same message as the main CLI.
- **A failed attempt is contained, not fatal to the round.** The 401 was
  recorded as one failed attempt with reasons attached and the run exited `0`,
  matching the intent recorded in `docs/stage-11-evals.md` §11.1(5).
- Failure reasons are specific and include the actual answer and the tools
  actually called — the grader output above names the pattern, the received
  text, and `called nothing`.
- The JSON report is well-formed, carrying `schemaVersion`, provider, model,
  per-attempt `status`, `turnCount`, `toolsUsed`, and `failures`.

## What this attempt does *not* tell us

Nothing about DeepSeek, and nothing about chivgent's agent loop:

- No pass rate, per task or overall. No turn counts, tool-selection behaviour,
  or latency for any real model.
- No evidence about the failure modes the suite was built to catch — path
  guessing instead of `search_text`, whole-file rewrites instead of
  `edit_file`, CRLF damage, or hallucinated file contents. Every task ended
  before the model was reached.
- Token accounting (added in `1b70216`) is **untested against a real provider**.
  The `tokens` column rendered empty and `totalTokens` was `0`, which is
  correct for a run that made no successful call but says nothing about whether
  capture works when a call succeeds. Inconclusive.
- `deepseek-v4-flash` was never confirmed to be a valid model name. Auth fails
  before model resolution, so a wrong model name would look identical from
  here. It matches the shipped registry default and the run instructions, but
  this attempt did not verify it.

## chivgent defects found

Separated from the environmental blocker, because this one ships.

### D1 — the eval CLI cannot accept a key on the command line

`parseEvalArgs` (`src/evals/parse-args.ts`) whitelists only `--provider` and
`--model` for pass-through into `providerArgs`, and throws `Unknown option` on
anything else. So the eval runner can only obtain a credential from the
environment or `<CHIVGENT_HOME>/auth.json`.

This is inconsistent with the rest of the project:

- The main CLI accepts `--api-key` (`src/cli-options.ts:125`).
- The credential chain documents `--api-key` as the **highest-priority** source,
  ahead of the environment and the stored file (`src/auth/credentials.ts:17`),
  and the no-credential error tells the user to "pass `--api-key`"
  (`src/auth/credentials.ts:42`) — advice that is simply wrong under
  `npm run eval`.
- `src/evals/cli.ts:101` already forwards `providerArgs` to the main CLI's
  `parseCliArgs`, which handles `--api-key` correctly.

So the machinery is entirely in place; only the eval parser's whitelist blocks
it. The fix is to forward `--api-key` alongside `--provider` and `--model`, and
to list it in the eval `--help` output. **Not fixed here** — this run was meant
to measure what ships today, and patching the harness mid-measurement would
have defeated that. It is written up so the change can be made deliberately.

Severity: low impact on correctness, high impact on operability. It makes the
suite unrunnable in exactly the ephemeral/CI-shaped environments where a key
arrives as a flag rather than as persistent state.

**Fixed in the commit that landed this report.** `--api-key` now joins
`--provider` and `--model` in the set forwarded to the main CLI's parser, and
appears in `npm run eval -- --help`. The step-3 command below works as written.

### Not a defect

The runner's behaviour on auth failure is *correct*: it surfaces the provider
message, counts the attempt as a failure with reasons, and finishes the round
rather than aborting. That is the documented design.

## How to complete this baseline

1. Attach a real DeepSeek credential to the environment, as
   `DEEPSEEK_API_KEY`, or fix D1 and pass `--api-key`.
2. Re-run the smoke test. It must print `ok` before anything paid starts.
3. Then run (D1 is fixed, so `--api-key` works here too):

```
npm run eval -- --provider deepseek --allow-writes --allow-shell --attempts 3 --json baseline.json
```

4. Confirm `deepseek-v4-flash` resolves. `deepseek-chat` and `deepseek-reasoner`
   were retired on 2026-07-24 and will error.

Until step 1 is satisfied, no amount of re-running produces data.
