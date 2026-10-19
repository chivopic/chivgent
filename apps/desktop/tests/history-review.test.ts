import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHistory } from "../src/host/history.js";

const injected = vi.hoisted(() => ({ paths: new Map<number, string>(), shortBytes: 0, failLockSync: false, failAppendAfterPartial: false, partialWritten: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync(...args: Parameters<typeof real.openSync>) {
      const fd = real.openSync(...args);
      injected.paths.set(fd, String(args[0]));
      return fd;
    },
    closeSync(fd: number) {
      const result = real.closeSync(fd);
      injected.paths.delete(fd);
      return result;
    },
    fsyncSync(fd: number) {
      if (injected.failLockSync && injected.paths.get(fd)?.endsWith(".lock")) {
        injected.failLockSync = false;
        throw Object.assign(new Error("injected lock fsync ENOSPC"), { code: "ENOSPC" });
      }
      return real.fsyncSync(fd);
    },
    writeSync(fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) {
      if (injected.paths.get(fd)?.endsWith(".jsonl") && (injected.shortBytes > 0 || injected.failAppendAfterPartial)) {
        if (injected.failAppendAfterPartial && injected.partialWritten) throw Object.assign(new Error("injected partial append ENOSPC"), { code: "ENOSPC" });
        const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        const offset = typeof data === "string" || typeof rest[0] !== "number" ? 0 : rest[0];
        const length = typeof data === "string" || typeof rest[1] !== "number" ? bytes.byteLength - offset : rest[1];
        const count = Math.min(injected.shortBytes || 3, length);
        injected.partialWritten = true;
        return real.writeSync(fd, bytes, offset, count);
      }
      return Reflect.apply(real.writeSync, real, [fd, data, ...rest]);
    },
  };
});

const roots: string[] = [];
const opened: DesktopHistory[] = [];
function directory(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "chivgent-io-review-"));
  roots.push(root);
  return root;
}
function open(root: string): DesktopHistory {
  const history = DesktopHistory.open(root, "/tmp/review-project");
  opened.push(history);
  return history;
}
afterEach(() => {
  injected.shortBytes = 0;
  injected.failLockSync = false;
  injected.failAppendAfterPartial = false;
  injected.partialWritten = false;
  for (const history of opened.splice(0)) { try { history.close(); } catch {} }
  for (const fd of [...injected.paths.keys()]) { try { fs.closeSync(fd); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("independent history I/O regression review", () => {
  it("round-trips Unicode context when each journal syscall writes only three bytes", () => {
    const root = directory();
    const history = open(root);
    injected.shortBytes = 3;
    const messages = [{ role: "user", content: "中文恢复🌿 café" }] as const;
    history.saveContext(messages);
    history.close();
    injected.shortBytes = 0;
    const recovered = open(root).snapshot();
    expect(recovered.incomplete).toBe(false);
    expect(recovered.messages).toEqual(messages);
  });

  it("does not strand its writer lock when lock synchronization fails", () => {
    const root = directory();
    injected.failLockSync = true;
    expect(() => DesktopHistory.open(root, "/tmp/review-project")).toThrow("injected lock fsync");
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".lock"))).toEqual([]);
    expect(() => open(root)).not.toThrow();
  });

  it("refuses another append after a partially written record fails", () => {
    const root = directory();
    const history = open(root);
    const messages = [{ role: "user", content: "reliable original context" }] as const;
    history.saveContext(messages);
    injected.failAppendAfterPartial = true;
    expect(() => history.saveRun({ type: "run", runId: "run-partial", prompt: "never complete", status: "started" })).toThrow();
    injected.failAppendAfterPartial = false;
    const path = join(root, `${history.sessionId}.jsonl`);
    const before = fs.readFileSync(path, "utf8");
    expect(() => history.saveRun({ type: "run", runId: "run-later", prompt: "must not append", status: "started" })).toThrow();
    expect(fs.readFileSync(path, "utf8")).toBe(before);
    history.close();
    const recovered = open(root).snapshot();
    expect(recovered.incomplete).toBe(true);
    expect(recovered.activeRun?.runId).not.toBe("run-later");
    expect(fs.readFileSync(path, "utf8")).toContain("reliable original context");
  });
});
