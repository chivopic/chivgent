# Desktop tests

Desktop unit and integration tests are separate from the root `npm test` suite. Run them with:

```sh
npm run desktop:test
npm run desktop:build
node apps/desktop/scripts/verify-readonly.mjs
node apps/desktop/scripts/verify-history.mjs
```

The Electron scripts exercise the built app through its real IPC, utility host, Provider adapter, and workspace tools. They create a unique temporary project, profile, auth directory, history directory, dynamic localhost port, and host PID/log files for every process. The fake Provider is loopback-only; no real account, key, external model, or `~/.chivgent` data is used. A successful run quits Electron and removes its temporary resources.

The saved files in `apps/desktop/scripts/fixtures/protocol/` are hand-authored **synthetic** OpenAI-compatible SSE examples. They are not captured Provider traffic, and do not share a serialization path with the desktop adapter. The verification scripts fragment replay into small byte chunks; the cancellation case deliberately ends with a partial stream and waits for Stop.

To make a run fail at a controlled point and inspect diagnostics:

```sh
CHIVGENT_DESKTOP_ARTIFACT_DIR=/tmp/chivgent-desktop-artifacts \
CHIVGENT_DESKTOP_E2E_FAIL_AT=after-project-selected \
node apps/desktop/scripts/verify-history.mjs
```

The expected exit status is nonzero. The artifact directory receives a unique run subdirectory containing the failure stage/stack, sanitized request summary, fixture errors, Playwright trace, screenshot, and a Host stderr file (or an explicit no-output note). The script still closes owned Electron/Host processes, its localhost server, and temporary profile/project/history directories. If no artifact override is supplied, failures go under the ignored `apps/desktop/artifacts/desktop-e2e-failures/` directory. Do not attach raw environment dumps or real credentials to an artifact.

These offline checks are deterministic behavior tests. `npm run eval -- --dry-run --allow-writes --allow-shell` only validates eval task setup; it makes no model call. A live eval is paid and model output can vary, so it is separate from Desktop CI and must be reported as its own check.

The persistence tests follow SQLite's practice of injecting one-shot and repeated I/O failures at specific boundaries, then reopening the same files and checking what is known to have persisted. The Electron scripts borrow VS Code's isolated application lifecycle and Playwright traces. Saved responses borrow Gemini CLI's replay approach, but these repository fixtures are locally authored synthetic examples rather than captured provider data. See [SQLite I/O error testing](https://www.sqlite.org/testing.html#ioerrtesting), [VS Code smoke tests](https://github.com/microsoft/vscode/blob/main/test/smoke/README.md), and [Gemini CLI integration tests](https://geminicli.com/docs/integration-tests/).
