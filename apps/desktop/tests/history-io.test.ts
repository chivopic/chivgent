import { closeSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHistory, readLastProject, saveLastProject } from "../src/host/history.js";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

type FsArgs = unknown[];
type RealCall = (...args: FsArgs) => unknown;
const faults = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  write: null as null | ((real: RealCall, args: FsArgs) => number),
  sync: null as null | ((real: RealCall, args: FsArgs) => void),
  read: null as null | ((real: RealCall, args: FsArgs) => string),
  rename: null as null | ((real: RealCall, args: FsArgs) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync(...args: Parameters<typeof real.openSync>) {
      const fd = real.openSync(...args);
      faults.paths.set(fd, String(args[0]));
      return fd;
    },
    closeSync(fd: number) {
      try { return real.closeSync(fd); } finally { faults.paths.delete(fd); }
    },
    writeSync: (...args: FsArgs) => faults.write ? faults.write(real.writeSync as RealCall, args) : real.writeSync(...args as Parameters<typeof real.writeSync>),
    fsyncSync: (...args: FsArgs) => faults.sync ? faults.sync(real.fsyncSync as RealCall, args) : real.fsyncSync(...args as Parameters<typeof real.fsyncSync>),
    readFileSync: (...args: FsArgs) => faults.read ? faults.read(real.readFileSync as RealCall, args) : real.readFileSync(...args as Parameters<typeof real.readFileSync>),
    renameSync: (...args: FsArgs) => faults.rename ? faults.rename(real.renameSync as RealCall, args) : real.renameSync(...args as Parameters<typeof real.renameSync>),
  };
});

const roots: string[] = [];
const opened: DesktopHistory[] = [];
const services: HostService[] = [];
const project = "/tmp/chivgent-history-io-project-世界";
const sessionId = `session-${(await import("node:crypto")).createHash("sha256").update(project).digest("hex").slice(0, 24)}`;
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "chivgent-history-io-"));
  roots.push(path);
  return path;
}
function openHistory(directory: string): DesktopHistory {
  const history = DesktopHistory.open(directory, project);
  opened.push(history);
  return history;
}
afterEach(async () => {
  faults.write = null; faults.sync = null; faults.read = null; faults.rename = null;
  for (const history of opened.splice(0)) { try { history.close(); } catch { /* Test failures must not leak writer locks. */ } }
  for (const service of services.splice(0)) { try { await service.shutdown(); } catch { /* Keep cleanup independent from assertions. */ } }
  for (const fd of [...faults.paths.keys()]) { try { closeSync(fd); } catch { /* Test-owned descriptor already closed. */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (id: string, prompt = "恢复路径 世界 ✅") => ({ type: "run", runId: id, prompt, status: "started" as const });
describe("desktop history deterministic I/O failures", () => {
  it("releases the lock if lock initialization fails after creating its file", () => {
    const dir = fixture();
    faults.write = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    expect(() => DesktopHistory.open(dir, project)).toThrow(/ENOSPC|disk full/);
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    faults.write = null;
    const history = openHistory(dir);
    history.close();
  });

  it("releases the lock if lock fsync fails once and permits recovery", () => {
    const dir = fixture();
    faults.sync = (real, args) => { real(...args); throw Object.assign(new Error("lock sync failed"), { code: "EIO" }); };
    expect(() => DesktopHistory.open(dir, project)).toThrow(/EIO|sync failed/);
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    faults.sync = null;
    const history = openHistory(dir);
    history.close();
  });

  it("completes a short UTF-8 write instead of treating a byte count as a saved record", () => {
    const dir = fixture();
    const history = openHistory(dir);
    let first = true;
    faults.write = (real, args) => {
      if (first) {
        first = false;
        const bytes = Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1]));
        return real(args[0], bytes.subarray(0, 3));
      }
      return real(...args);
    };
    history.saveRun(run("short-write"));
    history.close();
    faults.write = null;
    const reopened = openHistory(dir);
    expect(reopened.snapshot()).toMatchObject({ incomplete: false, activeRun: { runId: "short-write", prompt: "恢复路径 世界 ✅" } });
    reopened.close();
  });

  it("does not append behind an uncertain partial JSONL write", () => {
    const dir = fixture();
    const history = openHistory(dir);
    history.saveRun(run("reliable"));
    const path = join(dir, `${sessionId}.jsonl`);
    let first = true;
    faults.write = (real, args) => {
      if (first) {
        first = false;
        const bytes = Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1]));
        real(args[0], bytes.subarray(0, 9));
        throw Object.assign(new Error("disk full after partial append"), { code: "ENOSPC" });
      }
      return real(...args);
    };
    expect(() => history.saveRun(run("uncertain"))).toThrow(/ENOSPC|disk full/);
    const damagedBytes = readFileSync(path);
    expect(() => history.saveRun(run("must-not-follow-damage"))).toThrow();
    expect(readFileSync(path)).toEqual(damagedBytes);
    history.close();
    faults.write = null;
    const reopened = openHistory(dir);
    expect(reopened.snapshot()).toMatchObject({ incomplete: true, activeRun: { runId: "reliable", status: "interrupted" } });
    reopened.close();
  });

  it("preserves the previous reliable checkpoint and blocks writes after fsync failure", () => {
    const dir = fixture();
    const history = openHistory(dir);
    history.saveRun(run("reliable"));
    faults.sync = (real, args) => { real(...args); throw Object.assign(new Error("sync failed"), { code: "EIO" }); };
    expect(() => history.saveContext([{ role: "user", content: "possibly persisted" }])).toThrow(/EIO|sync failed/);
    const path = join(dir, `${sessionId}.jsonl`);
    const bytesAfterFailure = readFileSync(path);
    expect(() => history.saveRun(run("after-uncertain-sync"))).toThrow();
    expect(readFileSync(path)).toEqual(bytesAfterFailure);
    history.close();
  });

  it("retries a one-shot and persistent recovery read failure without leaking the lock", () => {
    const dir = fixture();
    const history = openHistory(dir);
    history.saveRun(run("reliable"));
    history.close();
    let failures = 0;
    faults.read = (real, args) => {
      if (String(args[0]).endsWith(`${sessionId}.jsonl`)) {
        failures += 1;
        if (failures <= 2) throw Object.assign(new Error("read denied"), { code: "EACCES" });
      }
      return real(...args) as string;
    };
    expect(() => DesktopHistory.open(dir, project)).toThrow(/EACCES|read denied/);
    expect(() => DesktopHistory.open(dir, project)).toThrow(/EACCES|read denied/);
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    faults.read = null;
    const recovered = openHistory(dir);
    expect(recovered.snapshot().activeRun?.runId).toBe("reliable");
    recovered.close();
  });

  it("keeps the old metadata if its temporary write is short or fails to sync", () => {
    const dir = fixture();
    saveLastProject(dir, "/old/project");
    let first = true;
    faults.write = (real, args) => {
      if (first) { first = false; return real(args[0], Buffer.from(String(args[1])).subarray(0, 4)); }
      return real(...args);
    };
    saveLastProject(dir, "/new/project 世界");
    faults.write = null;
    expect(readLastProject(dir)).toBe("/new/project 世界");
    const prior = readFileSync(join(dir, "last-project.json"), "utf8");
    faults.sync = (real, args) => { throw Object.assign(new Error("metadata sync denied"), { code: "EACCES" }); };
    expect(() => saveLastProject(dir, "/third/project")).toThrow(/EACCES|sync denied/);
    expect(readFileSync(join(dir, "last-project.json"), "utf8")).toBe(prior);
    expect(readLastProject(dir)).toBe("/new/project 世界");
  });

  it("preserves metadata across rename failure and allows a later save", () => {
    const dir = fixture();
    saveLastProject(dir, "/old/project");
    faults.rename = (real, args) => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); };
    expect(() => saveLastProject(dir, "/new/project")).toThrow(/EACCES|rename denied/);
    expect(readLastProject(dir)).toBe("/old/project");
    faults.rename = null;
    saveLastProject(dir, "/new/project");
    expect(readLastProject(dir)).toBe("/new/project");
  });

  it("does not construct a model session when saving the accepted run fails", async () => {
    const dir = fixture();
    const projectPath = join(dir, "project");
    mkdirSync(projectPath);
    const messages: HostToMain[] = [];
    let factoryCalls = 0;
    const service = new HostService({
      send: (message) => messages.push(message), historyDirectory: join(dir, "history"),
      createAgent: () => { throw new Error("unexpected demo path"); },
      createSession: async () => {
        factoryCalls += 1;
        return { provider: "fixture", model: "fixture", session: { messages: [], subscribe: () => () => {}, prompt: async () => {} } };
      },
    });
    services.push(service);
    service.handle({ type: "select-project", requestId: "select", path: projectPath });
    await until(() => messages.some((message) => message.type === "project-selected"));
    faults.write = (real, args) => {
      if (faults.paths.get(Number(args[0]))?.endsWith(".jsonl")) throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
      return real(...args);
    };
    service.handle({ type: "start", requestId: "not-accepted", prompt: "must not reach model" });
    expect(messages.at(-1)).toMatchObject({ type: "error", requestId: "not-accepted", code: "history_write_failed", historyStage: "acceptance" });
    expect(factoryCalls).toBe(0);
  });

  it("keeps the selected project if metadata rename fails while switching", async () => {
    const dir = fixture();
    const firstProject = join(dir, "first");
    const secondProject = join(dir, "second");
    mkdirSync(firstProject); mkdirSync(secondProject);
    const messages: HostToMain[] = [];
    const service = new HostService({ send: (message) => messages.push(message), historyDirectory: join(dir, "history"), createAgent: () => { throw new Error("unused"); } });
    services.push(service);
    service.handle({ type: "select-project", requestId: "first", path: firstProject });
    await until(() => messages.some((message) => message.type === "project-selected" && message.requestId === "first"));
    faults.rename = (real, args) => {
      if (String(args[1]).endsWith("last-project.json")) throw Object.assign(new Error("metadata rename denied"), { code: "EACCES" });
      return real(...args);
    };
    service.handle({ type: "select-project", requestId: "second", path: secondProject });
    await until(() => messages.some((message) => message.type === "error" && message.requestId === "second"));
    faults.rename = null;
    service.handle({ type: "initialize", requestId: "snapshot" });
    expect(messages.at(-1)).toMatchObject({ type: "initialized", snapshot: { projectPath: realpathSync(firstProject) } });
  });

  it("keeps a checkpoint write failure visible after a model-completed event and snapshot refresh", async () => {
    const dir = fixture();
    const projectPath = join(dir, "project");
    mkdirSync(projectPath);
    const messages: HostToMain[] = [];
    let fileSyncCount = 0;
    const service = new HostService({
      send: (message) => messages.push(message), historyDirectory: join(dir, "history"),
      createAgent: () => { throw new Error("unexpected demo path"); },
      createSession: async () => {
        faults.sync = (real, args) => {
          if (faults.paths.get(Number(args[0]))?.endsWith(".jsonl") && ++fileSyncCount === 2) {
            real(...args);
            throw Object.assign(new Error("checkpoint fsync ENOSPC"), { code: "ENOSPC" });
          }
          real(...args);
        };
        return { provider: "fixture", model: "fixture", session: {
          messages: [{ role: "user", content: "completed response" }, { role: "assistant", content: "answer", toolCalls: [] }],
          subscribe: (listener) => { queueMicrotask(() => listener({ type: "agent_end", status: "completed" })); return () => {}; },
          prompt: async () => {},
        } };
      },
    });
    services.push(service);
    service.handle({ type: "select-project", requestId: "select", path: projectPath });
    await until(() => messages.some((message) => message.type === "project-selected"));
    service.handle({ type: "start", requestId: "run", prompt: "complete normally" });
    await until(() => messages.some((message) => message.type === "error" && message.runId !== undefined));
    expect(messages).toContainEqual(expect.objectContaining({ type: "event", event: { type: "agent_end", status: "completed" } }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", code: "history_write_failed", historyStage: "checkpoint" }));
    service.handle({ type: "initialize", requestId: "refresh" });
    expect(messages.at(-1)).toMatchObject({ type: "initialized", snapshot: { historyNotice: expect.stringContaining("checkpoint fsync ENOSPC") } });
  });

  it("keeps an event fsync failure classified as history failure after completed and in the snapshot", async () => {
    const dir = fixture();
    const projectPath = join(dir, "project");
    mkdirSync(projectPath);
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message), historyDirectory: join(dir, "history"),
      createAgent: () => { throw new Error("unexpected demo path"); },
      createSession: async () => ({ provider: "fixture", model: "fixture", session: {
        messages: [{ role: "user", content: "event persistence failed" }, { role: "assistant", content: "completed answer", toolCalls: [] }],
        subscribe: (listener) => {
          faults.sync = (real, args) => {
            if (faults.paths.get(Number(args[0]))?.endsWith(".jsonl")) {
              real(...args);
              throw Object.assign(new Error("tool event fsync EACCES"), { code: "EACCES" });
            }
            real(...args);
          };
          listener({ type: "tool_start", toolCallId: "event-fault", toolName: "read_file", args: {}, itemId: "item" });
          listener({ type: "agent_end", status: "completed" });
          return () => {};
        },
        prompt: async () => {},
      } }),
    });
    services.push(service);
    service.handle({ type: "select-project", requestId: "select", path: projectPath });
    await until(() => messages.some((message) => message.type === "project-selected"));
    service.handle({ type: "start", requestId: "run", prompt: "finish after event fsync error" });
    await until(() => messages.some((message) => message.type === "error" && message.runId !== undefined));
    expect(messages).toContainEqual(expect.objectContaining({ type: "event", event: { type: "agent_end", status: "completed" } }));
    const runErrors = messages.filter((message) => message.type === "error" && message.runId !== undefined);
    expect(runErrors.some((message) => message.type === "error" && message.code === "run_error")).toBe(false);
    expect(runErrors).toContainEqual(expect.objectContaining({ type: "error", code: "history_write_failed", historyStage: "checkpoint" }));
    service.handle({ type: "initialize", requestId: "refresh" });
    expect(messages.at(-1)).toMatchObject({ type: "initialized", snapshot: { historyNotice: expect.stringContaining("tool event fsync EACCES") } });
  });

  it("keeps the original runtime error terminal when recording unknown status also fails", async () => {
    const dir = fixture();
    const projectPath = join(dir, "project");
    mkdirSync(projectPath);
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message), historyDirectory: join(dir, "history"),
      createAgent: () => { throw new Error("unexpected demo path"); },
      createSession: async () => {
        faults.sync = (real, args) => {
          if (faults.paths.get(Number(args[0]))?.endsWith(".jsonl")) {
            faults.sync = null;
            throw Object.assign(new Error("unknown terminal ENOSPC"), { code: "ENOSPC" });
          }
          real(...args);
        };
        throw new Error("original session factory failure");
      },
    });
    services.push(service);
    service.handle({ type: "select-project", requestId: "select", path: projectPath });
    await until(() => messages.some((message) => message.type === "project-selected"));
    service.handle({ type: "start", requestId: "run", prompt: "factory must fail" });
    await until(() => messages.some((message) => message.type === "error" && message.runId !== undefined));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", code: "run_error", message: "original session factory failure" }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", code: "history_write_failed", historyStage: "checkpoint" }));
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected host operation did not arrive.");
}
