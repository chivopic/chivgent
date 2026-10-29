import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHistory, readLastProject } from "../src/host/history.js";
import { isHostToMain } from "../src/protocol/messages.js";

const fsFailure = vi.hoisted(() => ({
  fsyncPath: undefined as string | undefined, triggered: false,
  fsyncMatches: 0, fsyncFailAfter: 0,
  unreadablePath: undefined as string | undefined,
  unlinkPath: undefined as string | undefined,
  shortWritePath: undefined as string | undefined, zeroWrite: false, failAfter: 0, writes: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const matches = (fd: number, path: string): boolean => {
    const target = actual.statSync(path);
    const current = actual.fstatSync(fd);
    return target.dev === current.dev && target.ino === current.ino;
  };
  return { ...actual, unlinkSync: (path: import("node:fs").PathLike) => {
    if (path === fsFailure.unlinkPath) throw new Error("injected marker cleanup failure");
    return actual.unlinkSync(path);
  }, readFileSync: (...args: unknown[]) => {
    if (fsFailure.unreadablePath !== undefined && (args[0] === fsFailure.unreadablePath || (typeof args[0] === "number" && matches(args[0], fsFailure.unreadablePath)))) throw Object.assign(new Error("injected marker read failure"), { code: "EACCES" });
    return Reflect.apply(actual.readFileSync, undefined, args);
  }, writeSync: (...args: unknown[]) => {
    if (fsFailure.shortWritePath !== undefined && matches(args[0] as number, fsFailure.shortWritePath)) {
      fsFailure.writes += 1;
      if (fsFailure.zeroWrite) return 0;
      if (fsFailure.failAfter > 0 && fsFailure.writes > fsFailure.failAfter) throw new Error("injected partial write failure");
      return actual.writeSync(args[0] as number, args[1] as Buffer, args[2] as number, Math.min(args[3] as number, 3));
    }
    return Reflect.apply(actual.writeSync, undefined, args);
  }, fsyncSync: (fd: number) => {
    if (fsFailure.fsyncPath !== undefined && !fsFailure.triggered) {
      const target = actual.statSync(fsFailure.fsyncPath);
      const current = actual.fstatSync(fd);
      if (target.dev === current.dev && target.ino === current.ino) {
        fsFailure.fsyncMatches += 1;
        if (fsFailure.fsyncMatches > fsFailure.fsyncFailAfter) {
          fsFailure.triggered = true;
          throw new Error("injected log fsync failure");
        }
      }
    }
    return actual.fsyncSync(fd);
  } };
});

const roots: string[] = [];
const opened: DesktopHistory[] = [];
const project = "/tmp/chivgent-history-project";
const sessionId = `session-${createHash("sha256").update(project).digest("hex").slice(0, 24)}`;
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "chivgent-history-boundary-"));
  roots.push(dir);
  return dir;
}
function open(dir: string): DesktopHistory {
  const history = DesktopHistory.open(dir, project);
  opened.push(history);
  return history;
}
const run = { type: "run", runId: "run-safe", prompt: "saved prompt", status: "started" } as const;
const line = (value: unknown): string => `${JSON.stringify({ version: 1, value })}\n`;
afterEach(() => {
  fsFailure.fsyncPath = undefined;
  fsFailure.triggered = false;
  fsFailure.fsyncMatches = 0;
  fsFailure.fsyncFailAfter = 0;
  fsFailure.unreadablePath = undefined;
  fsFailure.unlinkPath = undefined;
  fsFailure.shortWritePath = undefined;
  fsFailure.zeroWrite = false;
  fsFailure.failAfter = 0;
  fsFailure.writes = 0;
  for (const history of opened.splice(0)) history.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop history recovery boundaries", () => {
  it("recovers a lock only after its owner process has exited", () => {
    const dir = fixture();
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const pid = Number(child.stdout);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    writeFileSync(join(dir, `${sessionId}.lock`), JSON.stringify({ pid, sessionId }));
    const history = open(dir);
    history.saveRun(run);
    expect(history.snapshot().activeRun?.runId).toBe("run-safe");
    expect(() => DesktopHistory.open(dir, project)).toThrow();
  });

  it("releases its writer lock when the history file cannot be read", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    mkdirSync(path);
    expect(() => DesktopHistory.open(dir, project)).toThrow();
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    rmSync(path, { recursive: true });
    expect(open(dir).snapshot().incomplete).toBe(false);
  });

  it("releases its writer lock when syncing the lock fails", () => {
    const dir = fixture();
    fsFailure.fsyncPath = join(dir, `${sessionId}.lock`);
    expect(() => open(dir)).toThrow("injected log fsync failure");
    expect(fsFailure.triggered).toBe(true);
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    fsFailure.fsyncPath = undefined;
    expect(open(dir).snapshot().incomplete).toBe(false);
  });

  it("does not treat a log read error as an empty session", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const original = line(run);
    writeFileSync(path, original);
    fsFailure.unreadablePath = path;
    expect(() => open(dir)).toThrow("injected marker read failure");
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    fsFailure.unreadablePath = undefined;
    expect(open(dir).snapshot().activeRun).toMatchObject({ runId: "run-safe", status: "interrupted" });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each([
    { suffix: "{broken", corruption: "tail" },
    { suffix: `{broken\n${line({ ...run, runId: "run-after-damage" })}`, corruption: "middle" },
  ])("preserves readable history and refuses writes after $corruption damage", ({ suffix, corruption }) => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const original = line(run) + suffix;
    writeFileSync(path, original);
    const history = open(dir);
    expect(history.snapshot()).toMatchObject({ incomplete: true, corruption, activeRun: { runId: "run-safe", status: "interrupted" } });
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each([
    { type: "context", messages: 17 },
    { type: "context", messages: [{ role: "system", content: "unexpected role" }] },
    { type: "context", messages: [{ role: "assistant", content: "missing tool-call list" }] },
    { type: "context", messages: [{ role: "tool", content: "uncorrelated result" }] },
    { type: "context", messages: [], compaction: { splitIndex: -1, state: null } },
    { type: "context", messages: [{ role: "assistant", content: null }] },
    { type: "run", runId: "run-invalid", prompt: "bad", status: "invented-success" },
    { type: "event", runId: "run-invalid", sequence: 1.5, event: { type: "agent_end" } },
  ])("reports malformed records as unknown instead of restoring them: %j", (malformed) => {
    const dir = fixture();
    writeFileSync(join(dir, `${sessionId}.jsonl`), line(malformed));
    const snapshot = open(dir).snapshot();
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.messages).toBeUndefined();
    expect(snapshot.activeRun).toBeUndefined();
    expect(snapshot.events).toEqual([]);
  });

  it("does not claim a failed append was saved", () => {
    const dir = fixture();
    const history = open(dir);
    const path = join(dir, `${sessionId}.jsonl`);
    rmSync(path);
    mkdirSync(path);
    expect(() => history.saveRun(run)).toThrow();
    expect(history.snapshot().activeRun).toBeUndefined();
  });

  it("does not restore a completed run after its log write succeeds but fsync fails", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    fsFailure.fsyncPath = path;
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("injected log fsync failure");
    expect(fsFailure.triggered).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"status":"completed"');
    history.close();
    fsFailure.fsyncPath = undefined;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { runId: "run-safe", status: "interrupted" } });
    expect(() => restored.saveRun({ ...run, runId: "must-not-append" })).toThrow();
  });

  it.each(["invalid", "unreadable", "outside-log", "inside-record"])("fails closed for an %s intent marker", (kind) => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const original = line(run) + line({ ...run, status: "completed" });
    writeFileSync(path, original);
    const marker = join(dir, `${sessionId}.intent`);
    writeFileSync(marker, kind === "invalid" ? "not valid json" : JSON.stringify({ version: 1, offset: kind === "outside-log" ? original.length + 1 : kind === "inside-record" ? 1 : original.length }));
    if (kind === "unreadable") fsFailure.unreadablePath = marker;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", runs: [], events: [] });
    expect(() => restored.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["dangling", "existing"])("does not trust a %s marker symlink", (target) => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const original = line(run) + line({ ...run, status: "completed" });
    writeFileSync(path, original);
    const linkTarget = join(dir, "marker-target");
    if (target === "existing") writeFileSync(linkTarget, JSON.stringify({ version: 1, offset: Buffer.byteLength(original) }));
    symlinkSync(linkTarget, join(dir, `${sessionId}.intent`));
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", runs: [] });
    expect(() => restored.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["dangling", "existing"])("does not trust a %s history log symlink", (target) => {
    const dir = fixture();
    const linkTarget = join(dir, "log-target");
    if (target === "existing") writeFileSync(linkTarget, line(run));
    symlinkSync(linkTarget, join(dir, `${sessionId}.jsonl`));
    expect(() => open(dir)).toThrow();
    expect(readdirSync(dir)).not.toContain(`${sessionId}.lock`);
    if (target === "existing") expect(readFileSync(linkTarget, "utf8")).toBe(line(run));
  });

  it("fails closed when syncing the marker file fails before the log write", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    const original = readFileSync(path, "utf8");
    fsFailure.fsyncPath = join(dir, `${sessionId}.intent`);
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("injected log fsync failure");
    expect(fsFailure.triggered).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(history.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain" });
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    history.close();
    fsFailure.fsyncPath = undefined;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { status: "interrupted" } });
    expect(() => restored.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("fails closed when syncing the marker directory fails before the log write", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    const original = readFileSync(path, "utf8");
    fsFailure.fsyncPath = dir;
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("injected log fsync failure");
    expect(fsFailure.triggered).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    history.close();
    fsFailure.fsyncPath = undefined;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { status: "interrupted" } });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("commits at log fsync without claiming that marker removal was directory-synced", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    fsFailure.fsyncPath = dir;
    fsFailure.fsyncFailAfter = 1;
    history.saveRun({ ...run, status: "completed" });
    expect(fsFailure.fsyncMatches).toBe(1);
    expect(fsFailure.triggered).toBe(false);
    expect(readFileSync(path, "utf8")).toContain('"status":"completed"');
    history.close();
    fsFailure.fsyncPath = undefined;
    expect(open(dir).snapshot()).toMatchObject({ incomplete: false, activeRun: { status: "completed" } });
  });

  it("keeps the marker and refuses appends when cleanup fails after log fsync", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    fsFailure.unlinkPath = join(dir, `${sessionId}.intent`);
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("injected marker cleanup failure");
    expect(readFileSync(path, "utf8")).toContain('"status":"completed"');
    expect(history.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain" });
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    history.close();
    fsFailure.unlinkPath = undefined;
    expect(open(dir).snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { status: "interrupted" } });
  });

  it("fails closed if an intent marker appears after the log was opened", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    const original = readFileSync(path, "utf8");
    writeFileSync(join(dir, `${sessionId}.intent`), JSON.stringify({ version: 1, offset: Buffer.byteLength(original) }));
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow();
    expect(history.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain" });
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("retries short log writes until the complete record is synchronized", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    fsFailure.shortWritePath = path;
    history.saveRun(run);
    expect(fsFailure.writes).toBeGreaterThan(1);
    fsFailure.shortWritePath = undefined;
    history.close();
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: false, activeRun: { status: "interrupted" } });
    expect(readFileSync(path, "utf8")).toBe(line(run));
  });

  it("fails closed on a zero-progress log write", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    const original = readFileSync(path, "utf8");
    fsFailure.shortWritePath = path;
    fsFailure.zeroWrite = true;
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("没有进展");
    history.close();
    fsFailure.shortWritePath = undefined;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { status: "interrupted" } });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("preserves a partial append while recovering only the known prefix", () => {
    const dir = fixture();
    const path = join(dir, `${sessionId}.jsonl`);
    const history = open(dir);
    history.saveRun(run);
    const original = readFileSync(path, "utf8");
    fsFailure.shortWritePath = path;
    fsFailure.failAfter = 1;
    expect(() => history.saveRun({ ...run, status: "completed" })).toThrow("injected partial write failure");
    const partial = readFileSync(path, "utf8");
    expect(partial).toBe(`${original}{\"v`);
    expect(() => history.saveRun({ ...run, runId: "must-not-append" })).toThrow();
    history.close();
    fsFailure.shortWritePath = undefined;
    const restored = open(dir);
    expect(restored.snapshot()).toMatchObject({ incomplete: true, corruption: "uncertain", activeRun: { status: "interrupted" } });
    expect(readFileSync(path, "utf8")).toBe(partial);
  });
});


describe("desktop snapshot protocol validation", () => {
  const snapshot = { hostInstanceId: "host-fixture", sessionId: "session-fixture", projectPath: "/tmp/project", sequence: 0, events: [], runs: [], incomplete: false, corruption: null };
  const initialized = (change: Record<string, unknown>) => ({ type: "initialized", requestId: "boot-fixture", protocolVersion: 1, hostInstanceId: "host-fixture", capabilities: [], defaultProvider: "openai", snapshot: { ...snapshot, ...change } });
  it.each([
    { sequence: -1 },
    { events: [{ sequence: 1, runId: "run-1", event: null }] },
    { events: [{ sequence: 1, runId: "run-1", event: {} }] },
    { runs: {} },
    { runs: [{ runId: "run-1", prompt: "hello", status: "invented-success" }] },
    { run: { runId: "run-1", prompt: 12, status: "running" } },
  ])("rejects malformed snapshot before renderer hydration: %j", (change) => {
    expect(isHostToMain(initialized(change))).toBe(false);
  });
});


describe("desktop project recovery metadata", () => {
  it("treats a missing metadata file as a first launch", () => {
    expect(readLastProject(fixture())).toBeUndefined();
  });
  it.each(["{broken", JSON.stringify({ version: 99, projectPath: "/tmp/project" }), JSON.stringify({ version: 1, projectPath: 17 })])("reports damaged metadata instead of a first launch: %s", (raw) => {
    const dir = fixture();
    writeFileSync(join(dir, "last-project.json"), raw);
    expect(() => readLastProject(dir)).toThrow();
  });
  it("reports an unreadable metadata file instead of a first launch", () => {
    const dir = fixture();
    mkdirSync(join(dir, "last-project.json"));
    expect(() => readLastProject(dir)).toThrow();
  });
});
