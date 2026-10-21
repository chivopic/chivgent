import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false }, utilityProcess: { fork } }));
vi.mock("../src/main/paths.js", () => ({ hostEntryError: () => undefined, hostEntryPath: () => "/fixture/host.mjs" }));

import { createHostBridge } from "../src/main/host-bridge.js";

class FakeUtilityProcess extends EventEmitter {
  pid = 8123;
  posts: unknown[] = [];
  kills = 0;
  killResult = true;
  postError: Error | undefined;
  postMessage(message: unknown) {
    if (this.postError) throw this.postError;
    this.posts.push(message);
  }
  kill() { this.kills += 1; return this.killResult; }
}

const fakeProcesses: FakeUtilityProcess[] = [];
afterEach(() => {
  vi.useRealTimers();
  fork.mockReset();
  fakeProcesses.length = 0;
});

function bridgeWithFakeHost() {
  const host = new FakeUtilityProcess();
  fakeProcesses.push(host);
  fork.mockReturnValue(host);
  const bridge = createHostBridge();
  bridge.start();
  host.emit("spawn");
  return { bridge, host };
}

describe("HostBridge shutdown", () => {
  it("does not resolve after kill until the owned utility process emits exit", async () => {
    vi.useFakeTimers();
    const { bridge, host } = bridgeWithFakeHost();
    let settled = false;
    const shutdown = bridge.shutdown().then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.kills).toBe(1);
    expect(settled).toBe(false);

    host.emit("exit", 0);
    await shutdown;
    expect(settled).toBe(true);
    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });

  it("waits for exit after the shutdown message throws and kill returns false", async () => {
    vi.useFakeTimers();
    const { bridge, host } = bridgeWithFakeHost();
    host.postError = new Error("message channel closed");
    host.killResult = false;
    let settled = false;
    const shutdown = bridge.shutdown().then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(host.kills).toBe(1);
    expect(settled).toBe(false);

    host.emit("exit", 0);
    await shutdown;
    expect(settled).toBe(true);
    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });

  it("bounds a failed kill that returns false without an exit event", async () => {
    vi.useFakeTimers();
    const { bridge, host } = bridgeWithFakeHost();
    host.postError = new Error("message channel closed");
    host.killResult = false;
    const shutdown = expect(bridge.shutdown()).rejects.toThrow(/did not exit within 2000ms after kill.*kill returned false/);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await shutdown;
  });

  it("shares an in-flight shutdown so repeated requests send only one message", async () => {
    const { bridge, host } = bridgeWithFakeHost();
    const first = bridge.shutdown();
    const second = bridge.shutdown();
    expect(host.posts).toEqual([{ type: "shutdown", requestId: "shutdown" }]);
    host.emit("exit", 0);
    await Promise.all([first, second]);
    expect(host.posts).toHaveLength(1);
  });
});
