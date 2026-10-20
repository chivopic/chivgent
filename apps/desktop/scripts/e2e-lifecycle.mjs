import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class E2EStageError extends Error {
  constructor(stage, timeoutMs) {
    super(`E2E teardown timed out during ${stage} after ${timeoutMs}ms`);
    this.name = "E2EStageError";
    this.stage = stage;
  }
}

export async function boundedStage(stage, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new E2EStageError(stage, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "state=", "-p", String(pid)], { timeout: 500, maxBuffer: 1024 });
    return stdout.trim() !== "" && !stdout.trim().startsWith("Z");
  } catch (error) {
    if (error.code === 1) return false;
    try { process.kill(pid, 0); return true; } catch (signalError) {
      if (signalError.code === "ESRCH") return false;
      throw signalError;
    }
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pidIsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !await pidIsAlive(pid);
}

async function waitForPidsExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let surviving = pids;
  while (Date.now() < deadline) {
    const states = await Promise.all(surviving.map(async pid => ({ pid, alive: await pidIsAlive(pid) })));
    surviving = states.filter(state => state.alive).map(state => state.pid);
    if (!surviving.length) return [];
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const states = await Promise.all(surviving.map(async pid => ({ pid, alive: await pidIsAlive(pid) })));
  return states.filter(state => state.alive).map(state => state.pid);
}

export async function listOwnedDescendants(rootPid) {
  const descendants = [];
  const pending = [rootPid];
  const seen = new Set(pending);
  while (pending.length) {
    const parent = pending.shift();
    let output = "";
    try {
      ({ stdout: output } = await execFileAsync("pgrep", ["-P", String(parent)], { timeout: 500, maxBuffer: 1024 }));
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    for (const item of output.split(/\s+/).filter(Boolean)) {
      const pid = Number(item);
      if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      pending.push(pid);
    }
  }
  return descendants;
}

async function terminatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !await pidIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (await waitForPidExit(pid, 1_000)) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (!await waitForPidExit(pid, 1_000)) throw new Error(`PID ${pid} remained alive after SIGKILL`);
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  try {
    // `close` waits for every inherited stdio pipe to close, including pipes
    // held by renderer/GPU descendants. `exit` is the owned OS process exit;
    // descendants are checked and reaped separately below.
    await boundedStage("Electron OS process exit", () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    }), timeoutMs);
    return true;
  } catch { return false; }
}

async function ownedProcessStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return `PID ${pid ?? "unknown"}: unavailable`;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,ppid=,state=,comm=", "-p", String(pid)], { timeout: 500, maxBuffer: 1024 });
    return `PID ${pid}: ${stdout.trim() || "exited"}`;
  } catch (error) {
    return `PID ${pid}: status unavailable (${error.message})`;
  }
}

async function readPid(path) {
  if (!path) return undefined;
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    if (!Number.isSafeInteger(value) || value <= 1) throw new Error(`invalid PID value in ${path}`);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`missing PID file ${path}`, { cause: error });
    throw error;
  }
}

export async function shutdownElectron({ app, hostPidFile, diagnosticsFile, timeoutMs = 5_000, listDescendants = listOwnedDescendants }) {
  if (!app) return;
  const owner = app.process();
  const ownerLabel = `Electron PID ${owner?.pid ?? "unknown"}`;
  const ownerStartedAt = Date.now();
  let ownerCloseObserved = Boolean(owner?.closed);
  let ownerExitAt;
  let ownerCloseAt = ownerCloseObserved ? Date.now() : undefined;
  owner?.once("exit", () => { ownerExitAt = Date.now(); });
  if (owner && !owner.closed) owner.once("close", () => { ownerCloseObserved = true; ownerCloseAt = Date.now(); });
  const failures = [];
  let descendants = [];
  let descendantSnapshotError;
  try { descendants = await boundedStage(`Electron child-process snapshot (${ownerLabel})`, () => listDescendants(owner?.pid), timeoutMs); }
  catch (error) { descendantSnapshotError = error; }
  let closePromise;
  try {
    try {
      // Let the CDP evaluation reply before requesting shutdown: destroying the
      // execution context during app.quit() can strand the evaluate response.
      // ElectronApplication.close() also calls app.quit() and waits on a close
      // event, so keep this to exactly one explicit quit request.
      await boundedStage(`Electron quit scheduling (${ownerLabel})`, () => app.evaluate(({ app: electronApp }) => {
        const quit = electronApp.quit.bind(electronApp);
        electronApp.quit = () => {
          electronApp.quit = quit;
          setImmediate(quit);
        };
      }), timeoutMs);
      closePromise = Promise.resolve().then(() => app.close());
      closePromise.catch(() => {});
    } catch (error) {
      const targetClosed = /Target (?:page|context|browser).*has been closed|Electron application has been closed/i.test(error.message);
      if (!targetClosed || !await waitForChildExit(owner, 100)) {
        failures.push(error instanceof E2EStageError ? error : new Error(`Electron app.quit request (${ownerLabel}) failed: ${error.message}`, { cause: error }));
      }
    }
    if (!await waitForChildExit(owner, timeoutMs)) failures.push(new E2EStageError(`Electron OS process exit (${ownerLabel})`, timeoutMs));
    const hostPid = await readPid(hostPidFile);
    if (await waitForPidExit(hostPid, 500) === false) failures.push(new E2EStageError(`Agent host shutdown (PID ${hostPid}, owner ${ownerLabel})`, timeoutMs));
    const surviving = await waitForPidsExit(descendants, 1_000);
    if (surviving.length) {
      const statuses = await Promise.all([owner?.pid, ...surviving].map(ownedProcessStatus));
      failures.push(new E2EStageError(`Electron child-process shutdown (PIDs ${surviving.join(", ")}; ${statuses.join("; ")}; owner exitCode=${owner?.exitCode}, signalCode=${owner?.signalCode}, closeObserved=${ownerCloseObserved})`, timeoutMs));
    }
    if (descendantSnapshotError) failures.push(new Error(`could not snapshot Electron child processes (${ownerLabel}): ${descendantSnapshotError.message}`));
    if (failures.length === 0) {
      try { await boundedStage(`Playwright app.close (${ownerLabel})`, () => closePromise, 1_000); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 0) return { ownerPid: owner?.pid, exitCode: owner?.exitCode, signalCode: owner?.signalCode,
      exitAfterMs: ownerExitAt === undefined ? undefined : ownerExitAt - ownerStartedAt,
      closeAfterMs: ownerCloseAt === undefined ? undefined : ownerCloseAt - ownerStartedAt,
      hostPid, descendants };
  } catch (error) {
    failures.push(error);
  }

  let hostPid;
  try { hostPid = await readPid(hostPidFile); } catch (error) { failures.push(new Error(`could not determine owned host PID (owner ${ownerLabel}): ${error.message}`)); }
  if (descendantSnapshotError) failures.push(new Error(`could not snapshot Electron child processes (${ownerLabel}): ${descendantSnapshotError.message}`));
  for (const pid of descendants.reverse()) {
    try { await terminatePid(pid); } catch (error) { failures.push(new Error(`Electron child PID ${pid} cleanup (${ownerLabel}): ${error.message}`)); }
  }
  try { await terminatePid(hostPid); } catch (error) { failures.push(new Error(`host PID ${hostPid ?? "unknown"} cleanup (owner ${ownerLabel}): ${error.message}`)); }
  try {
    if (owner?.pid && !await waitForChildExit(owner, 25)) {
      try { owner.kill("SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      if (!await waitForChildExit(owner, 1_000)) {
        try { owner.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        if (!await waitForChildExit(owner, 1_000)) throw new Error(`Electron PID ${owner.pid} remained alive after SIGKILL`);
      }
    }
  } catch (error) { failures.push(new Error(`Electron PID ${owner?.pid ?? "unknown"} cleanup: ${error.message}`)); }
  const primary = failures[0];
  if (primary) {
    if (failures.length > 1) primary.message += `; cleanup errors: ${failures.slice(1).map(error => error.message).join("; ")}`;
    primary.message += `; owner process state: pid=${owner?.pid ?? "unknown"}, exitCode=${owner?.exitCode}, signalCode=${owner?.signalCode}, exitAfterMs=${ownerExitAt === undefined ? "pending" : ownerExitAt - ownerStartedAt}, closeObserved=${ownerCloseObserved}, closeAfterMs=${ownerCloseAt === undefined ? "pending" : ownerCloseAt - ownerStartedAt}`;
    if (diagnosticsFile) {
      try {
        const trace = await boundedStage("shutdown diagnostic read", () => readFile(diagnosticsFile, "utf8"), 500);
        primary.message += `; lifecycle trace: ${trace.trim() || "(empty)"}`;
      } catch (error) {
        if (error.code !== "ENOENT") primary.message += `; lifecycle trace unavailable: ${error.message}`;
      }
    }
    throw primary;
  }
}

export async function cleanupE2EResources({ server, root, timeoutMs = 5_000 }) {
  const failures = [];
  if (server) {
    try {
      server.closeAllConnections?.();
      await boundedStage("fixture HTTP server close", () => new Promise((resolve, reject) => {
        server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
      }), timeoutMs);
    } catch (error) { failures.push(error); }
  }
  if (root) {
    try { await boundedStage("temporary directory removal", () => rm(root, { recursive: true, force: true }), timeoutMs); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const primary = failures[0];
    if (failures.length > 1) primary.message += `; cleanup errors: ${failures.slice(1).map(error => error.message).join("; ")}`;
    throw primary;
  }
}
