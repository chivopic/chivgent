import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupE2EResources, shutdownElectron } from "../scripts/e2e-lifecycle.mjs";

const roots: string[] = [];
const children: ChildProcess[] = [];
const shutdown = (options: Parameters<typeof shutdownElectron>[0]) => shutdownElectron({ listDescendants: async () => [], ...options });
function child() {
  const process = spawn(globalThis.process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(process);
  return process;
}
function exited(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise<void>(resolve => process.once("close", () => resolve()));
}
async function exitedWithin(process: ChildProcess, timeoutMs = 1_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([exited(process).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}
afterEach(async () => {
  for (const process of children.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    await exited(process);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Electron E2E teardown", () => {
  it("sends one normal quit request and returns after the owned Electron and host processes exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-e2e-normal-quit-")); roots.push(root);
    const hostPidFile = join(root, "host.pid");
    const host = child();
    writeFileSync(hostPidFile, `${host.pid}\n`);
    const electron = child();
    let quitRequests = 0;
    const electronApp = { quit: () => { quitRequests += 1; if (quitRequests === 1) electronApp.quit(); else { host.kill("SIGTERM"); electron.kill("SIGTERM"); } } };
    const app = {
      process: () => electron,
      evaluate: async (callback: (arg: { app: typeof electronApp }) => void) => callback({ app: electronApp }),
      close: async () => { electronApp.quit(); await exited(electron); },
    };

    await expect(shutdown({ app, hostPidFile, timeoutMs: 500 })).resolves.toMatchObject({ ownerPid: electron.pid, exitCode: null, signalCode: "SIGTERM" });
    expect(quitRequests).toBe(2);
    expect(await exitedWithin(host)).toBe(true);
    expect(await exitedWithin(electron)).toBe(true);
    expect(host.signalCode).toBe("SIGTERM");
    expect(electron.signalCode).toBe("SIGTERM");
  });

  it("distinguishes Electron OS exit from delayed stdio close held by an owned descendant", async () => {
    const owner = spawn(globalThis.process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], { stdio: 'inherit', detached: true });
      process.send({ pid: descendant.pid }, () => process.exit(0));
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(owner);
    const [{ pid: descendantPid }] = await once(owner, "message") as [{ pid: number }];
    let ownerExitAt = 0;
    let ownerCloseAt = 0;
    const ownerClosed = once(owner, "close");
    owner.once("exit", () => { ownerExitAt = Date.now(); });
    owner.once("close", () => { ownerCloseAt = Date.now(); });

    await expect(shutdown({ app: { process: () => owner, evaluate: async () => {}, close: async () => {} }, timeoutMs: 700, listDescendants: async () => [descendantPid] }))
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Electron child-process shutdown"), message: expect.stringContaining(`PID ${descendantPid}`) });
    expect(owner.exitCode).toBe(0);
    expect(owner.signalCode).toBeNull();
    await ownerClosed;
    expect(ownerCloseAt).toBeGreaterThanOrEqual(ownerExitAt);
  });

  it("bounds Playwright's single app.quit request and reaps the fixture host and Electron owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-e2e-teardown-")); roots.push(root);
    const hostPidFile = join(root, "host.pid");
    const host = child();
    writeFileSync(hostPidFile, `${host.pid}\n`);
    const electron = child();
    const app = { process: () => electron, evaluate: () => new Promise(() => {}), close: () => { throw new Error("close must not be used after quit scheduling failure"); } };

    await expect(shutdown({ app, hostPidFile, timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Electron quit scheduling"), message: expect.stringContaining(`Electron PID ${electron.pid}`) });
    expect(await exitedWithin(host)).toBe(true);
    expect(await exitedWithin(electron)).toBe(true);
    expect(host.exitCode).toBeNull();
    expect(host.signalCode).toBe("SIGTERM");
    expect(electron.signalCode).toBe("SIGTERM");
    await cleanupE2EResources({ root });
    expect(existsSync(root)).toBe(false);
  });

  it("bounds a hung quit request and tolerates target-closed quit rejection", async () => {
    const electron = child();
    const hangingClose = { process: () => electron, evaluate: () => new Promise(() => {}), close: () => { throw new Error("close must not be used for normal shutdown"); } };
    await expect(shutdown({ app: hangingClose, timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Electron quit scheduling"), message: expect.stringContaining(`Electron PID ${electron.pid}`) });
    expect(await exitedWithin(electron)).toBe(true);
    expect(electron.signalCode).toBe("SIGTERM");

    const alreadyClosed = spawn(globalThis.process.execPath, ["-e", ""], { stdio: "ignore" });
    children.push(alreadyClosed);
    await exited(alreadyClosed);
    const targetClosed = { process: () => alreadyClosed, evaluate: () => Promise.reject(new Error("Target page, context or browser has been closed")) };
    await expect(shutdown({ app: targetClosed, timeoutMs: 500 })).resolves.toMatchObject({ ownerPid: alreadyClosed.pid, exitCode: 0 });
  });

  it("bounds a hung Playwright close and reaps the owner", async () => {
    const electron = child();
    const electronApp = { quit: () => electron.kill("SIGTERM") };
    const app = { process: () => electron, evaluate: async (callback: (arg: { app: typeof electronApp }) => void) => callback({ app: electronApp }), close: () => { electronApp.quit(); return new Promise(() => {}); } };
    await expect(shutdown({ app, timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Playwright app.close"), message: expect.stringContaining(`Electron PID ${electron.pid}`) });
    expect(await exitedWithin(electron)).toBe(true);
    expect(electron.signalCode).toBe("SIGTERM");
  });

  it("still reaps Electron when its host PID file is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-e2e-bad-host-pid-")); roots.push(root);
    const hostPidFile = join(root, "host.pid");
    writeFileSync(hostPidFile, "not-a-pid\n");
    const electron = child();
    const app = { process: () => electron, evaluate: () => new Promise(() => {}) };

    await expect(shutdown({ app, hostPidFile, timeoutMs: 500 }))
      .rejects.toThrow(/could not determine owned host PID.*invalid PID value/);
    expect(await exitedWithin(electron)).toBe(true);
    expect(electron.signalCode).toBe("SIGTERM");
  });

  it("uses SIGKILL and awaits process close when Electron ignores SIGTERM", async () => {
    const electron = spawn(globalThis.process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(electron);
    await once(electron, "message");
    const app = { process: () => electron, evaluate: () => new Promise(() => {}) };

    await expect(shutdown({ app, timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "E2EStageError", message: expect.stringContaining(`Electron PID ${electron.pid}`) });
    expect(await exitedWithin(electron)).toBe(true);
    expect(electron.signalCode).toBe("SIGKILL");
  });
});
