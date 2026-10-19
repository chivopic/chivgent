import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHistory, readLastProject } from "../src/host/history.js";
import { isHostToMain } from "../src/protocol/messages.js";

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
