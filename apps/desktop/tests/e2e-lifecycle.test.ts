import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupE2EResources, shutdownElectron } from "../scripts/e2e-lifecycle.mjs";

const roots: string[] = [];
const children: ChildProcess[] = [];
const shutdown = (options: Parameters<typeof shutdownElectron>[0]) => shutdownElectron({ ...options, listDescendants: async () => [] });
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
    const app = {
      process: () => electron,
      evaluate: async () => { quitRequests += 1; host.kill("SIGTERM"); electron.kill("SIGTERM"); },
      close: () => { throw new Error("Playwright close must not issue a duplicate quit request"); },
    };

    await expect(shutdown({ app, hostPidFile, timeoutMs: 500 })).resolves.toBeUndefined();
    expect(quitRequests).toBe(1);
    expect(await exitedWithin(host)).toBe(true);
    expect(await exitedWithin(electron)).toBe(true);
    expect(host.signalCode).toBe("SIGTERM");
    expect(electron.signalCode).toBe("SIGTERM");
  });

  it("bounds Playwright's single app.quit request and reaps the fixture host and Electron owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-e2e-teardown-")); roots.push(root);
    const hostPidFile = join(root, "host.pid");
    const host = child();
    writeFileSync(hostPidFile, `${host.pid}\n`);
    const electron = child();
    const app = { process: () => electron, evaluate: () => new Promise(() => {}), close: () => { throw new Error("close must not be used for normal shutdown"); } };

    await expect(shutdown({ app, hostPidFile, timeoutMs: 500 }))
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Electron app.quit request"), message: expect.stringContaining(`Electron PID ${electron.pid}`) });
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
      .rejects.toMatchObject({ name: "E2EStageError", stage: expect.stringContaining("Electron app.quit request"), message: expect.stringContaining(`Electron PID ${electron.pid}`) });
    expect(await exitedWithin(electron)).toBe(true);
    expect(electron.signalCode).toBe("SIGTERM");

    const alreadyClosed = spawn(globalThis.process.execPath, ["-e", ""], { stdio: "ignore" });
    children.push(alreadyClosed);
    await exited(alreadyClosed);
    const targetClosed = { process: () => alreadyClosed, evaluate: () => Promise.reject(new Error("Target page, context or browser has been closed")) };
    await expect(shutdown({ app: targetClosed, timeoutMs: 500 })).resolves.toBeUndefined();
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
