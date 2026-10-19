import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const SECRET_TEXT = /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(["']?\s*[:=]\s*["']?)[^\s,"'}]{6,})/gi;

export async function createOfflineE2EFixture({ desktop, prefix, model, requestHandler, timeoutMs = 120_000 }) {
  const require = createRequire(join(desktop, "package.json"));
  const { _electron: electron } = require("playwright-core");
  const electronExecutable = require("electron");
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const project = join(root, "中文 project");
  const auth = join(root, "auth");
  const profile = join(root, "profile");
  const history = join(root, "history");
  const hostPidFile = join(root, "host.pid");
  const hostLogFile = join(root, "host.stderr.log");
  try {
    await Promise.all([mkdir(project), mkdir(auth), mkdir(history)]);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const requests = [];
  const fixtureErrors = [];
  let app;
  let page;
  let context;
  const tracedContexts = [];
  let stage = "setup";
  let artifactDirectory;
  let traceStarted = false;
  let failureCaptured = false;
  let capturePromise;
  let cleanupPromise;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-key");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      await requestHandler({ body, request, response, requests, fixtureErrors, project, root });
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  try {
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const environment = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "XAUTHORITY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }

  const progress = (label) => {
    stage = label;
    console.log(`Desktop E2E (${prefix}): ${label}`);
    if (process.env.CHIVGENT_DESKTOP_E2E_FAIL_AT === label) throw new Error(`Injected verification failure at stage: ${label}`);
  };
  const launch = async () => {
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [resolve(desktop), `--user-data-dir=${profile}`],
      cwd: root,
      env: { ...environment, CHIVGENT_DESKTOP_HOST_PID_FILE: hostPidFile, CHIVGENT_DESKTOP_HOST_LOG_FILE: hostLogFile,
        CHIVGENT_DESKTOP_HISTORY_DIR: history, CHIVGENT_HOME: auth, CHIVGENT_PROVIDER: "openai-compatible",
        OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: model, OPENAI_BASE_URL: endpoint },
    });
    context = app.context();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    traceStarted = true;
    tracedContexts.push(context);
    page = await app.firstWindow();
    await page.getByTestId("host-status").getByText("已连接", { exact: false }).waitFor({ timeout: 20_000 });
    return { app, page, context };
  };

  function captureFailure(error) {
    if (capturePromise !== undefined) return capturePromise;
    failureCaptured = true;
    capturePromise = (async () => {
      const requested = process.env.CHIVGENT_DESKTOP_ARTIFACT_DIR;
      const destination = requested === undefined ? join(desktop, "artifacts", "desktop-e2e-failures") : resolve(requested);
      await mkdir(destination, { recursive: true });
      artifactDirectory = await mkdtemp(join(destination, `${prefix}-`));
      const diagnosis = { stage, error: sanitize(error instanceof Error ? error.stack ?? error.message : String(error)) };
      await writeFile(join(artifactDirectory, "failure.json"), `${JSON.stringify(diagnosis, null, 2)}\n`);
      await writeFile(join(artifactDirectory, "requests.sanitized.json"), `${JSON.stringify(requestSummary(requests), null, 2)}\n`);
      await writeFile(join(artifactDirectory, "fixture-errors.sanitized.json"), `${JSON.stringify(sanitize(fixtureErrors), null, 2)}\n`);
      const traceErrors = [];
      for (const [index, tracedContext] of tracedContexts.entries()) {
        try {
          await withTimeout(tracedContext.tracing.stop({ path: join(artifactDirectory, `trace-${index + 1}.zip`) }), 5_000, "trace capture");
        } catch (traceError) {
          traceErrors.push(sanitize(traceError instanceof Error ? traceError.message : String(traceError)));
        }
      }
      traceStarted = false;
      if (traceErrors.length > 0) await writeFile(join(artifactDirectory, "trace-error.txt"), traceErrors.join("\n"));
      try { if (page !== undefined) await withTimeout(page.screenshot({ path: join(artifactDirectory, "failure.png"), fullPage: true }), 5_000, "screenshot"); } catch { /* App may already have exited. */ }
      let hostLog = "[Agent host did not write stderr before the failure.]";
      try { hostLog = await readFile(hostLogFile, "utf8"); } catch { /* Host may not have started. */ }
      await writeFile(join(artifactDirectory, "host.stderr.sanitized.log"), sanitize(hostLog));
      return artifactDirectory;
    })();
    return capturePromise;
  }

  async function stopApp(force = false) {
    const current = app;
    if (current === undefined) return;
    app = undefined;
    const child = current.process();
    try {
      if (!force) await withTimeout(current.evaluate(({ app: electronApp }) => electronApp.quit()), 2_000, "Electron quit");
    } catch { /* Escalate to process cleanup below. */ }
    try { await withTimeout(current.close(), 2_000, "Playwright close"); } catch { /* Escalate to process cleanup below. */ }
    if (child?.exitCode === null && child.pid !== undefined) {
      try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
      await waitForExit(child, 1_500);
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
        await waitForExit(child, 1_500);
      }
    }
    await reapHost(hostPidFile);
  }

  function cleanup() {
    if (cleanupPromise !== undefined) return cleanupPromise;
    clearTimeout(watchdog);
    cleanupPromise = (async () => {
    try {
        await withTimeout(stopApp(failureCaptured), 10_000, "application cleanup");
    } finally {
      try {
        if (traceStarted) {
          for (const tracedContext of tracedContexts) {
            try { await withTimeout(tracedContext.tracing.stop(), 5_000, "trace cleanup"); } catch { /* Continue with the remaining app contexts. */ }
          }
        }
      } catch { /* Trace is only retained for failed runs. */ }
      server.closeAllConnections();
      await withTimeout(new Promise((accept) => server.close(() => accept())), 3_000, "fixture server cleanup").catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
    })();
    return cleanupPromise;
  }

  const watchdog = setTimeout(() => {
    const error = new Error(`Electron E2E deadline exceeded during: ${stage}`);
    void (async () => {
      try {
        const path = await withTimeout(captureFailure(error), 12_000, "failure artifact capture");
        console.error(`Desktop E2E failure artifacts: ${path}`);
      } catch (captureError) {
        console.error(`Desktop E2E artifact capture failed: ${sanitize(captureError instanceof Error ? captureError.message : String(captureError))}`);
      } finally {
        try { await withTimeout(cleanup(), 30_000, "watchdog cleanup"); } catch (cleanupError) {
          console.error(`Desktop E2E cleanup failed: ${sanitize(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))}`);
        }
        process.exit(1);
      }
    })();
  }, timeoutMs);
  watchdog.unref();

  return {
    root, project, auth, profile, history, hostPidFile, hostLogFile, endpoint, requests, fixtureErrors,
    progress, launch, quitApp: () => stopApp(false), captureFailure, cleanup,
  };
}

function requestSummary(requests) {
  return requests.map((request) => ({
    model: request.model,
    messageCount: Array.isArray(request.messages) ? request.messages.length : null,
    messages: Array.isArray(request.messages) ? request.messages.map((message) => ({
      role: message.role,
      content: sanitize(typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null)),
      toolCallIds: Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call.id) : undefined,
      toolCallId: message.tool_call_id,
      toolName: message.name,
    })) : [],
    toolNames: Array.isArray(request.tools) ? request.tools.map((tool) => tool?.function?.name).filter(Boolean) : [],
  }));
}

function sanitize(value) {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[REDACTED]").replace(/fixture-key/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key, /authorization|api[_-]?key|token|password|secret/i.test(key) ? "[REDACTED]" : sanitize(child),
  ]));
  return value;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([new Promise((accept) => child.once("exit", accept)), new Promise((accept) => setTimeout(accept, timeoutMs))]);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function reapHost(path) {
  let pid;
  try { pid = Number(await readFile(path, "utf8")); } catch { return; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); } catch { return; }
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await new Promise((accept) => setTimeout(accept, 150));
  try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* Exited. */ }
}
