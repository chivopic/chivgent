import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHistory, saveLastProject } from "../src/host/history.js";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string { const path = mkdtempSync(join(tmpdir(), "desktop-history-test-")); roots.push(path); return path; }

describe("desktop versioned history", () => {
  it("restarts from a temporary interrupted-session fixture using initialize only", async () => {
    const root = temp();
    const project = join(root, "project");
    const historyDir = join(root, "history");
    mkdirSync(project);
    const canonicalProject = realpathSync(project);
    const fixture = DesktopHistory.open(historyDir, canonicalProject);
    fixture.saveRun({ type: "run", runId: "interrupted-run", prompt: "do not replay", status: "started" });
    fixture.close();
    saveLastProject(historyDir, canonicalProject);

    const messages: HostToMain[] = [];
    let promptCalls = 0;
    const restartedHost = new HostService({
      send: (message) => messages.push(message),
      historyDirectory: historyDir,
      createAgent: () => { throw new Error("unexpected demo fallback"); },
      createSession: async () => {
        return { provider: "openai", model: "fixture", session: {
          messages: [], subscribe: () => () => {}, prompt: async () => { promptCalls += 1; },
        } };
      },
    });

    restartedHost.handle({ type: "initialize", requestId: "explicit-recovery" });

    expect(messages[0]).toMatchObject({
      type: "initialized",
      requestId: "explicit-recovery",
      snapshot: { projectPath: canonicalProject, run: { runId: "interrupted-run", status: "interrupted" } },
    });
    expect(promptCalls).toBe(0);
    expect(messages[0]).not.toHaveProperty("permissions");
    expect(messages[0]).not.toHaveProperty("approval");
    await restartedHost.shutdown();
  });

  it("uses one writer lock and refuses a second writer", () => {
    const dir = temp();
    const history = DesktopHistory.open(dir, "/tmp/project");
    expect(() => DesktopHistory.open(dir, "/tmp/project")).toThrow();
    history.close();
    expect(readdirSync(dir)).toEqual([`${history.sessionId}.jsonl`]);
  });

  it("keeps readable records and exposes a damaged tail", () => {
    const dir = temp();
    const history = DesktopHistory.open(dir, "/tmp/project");
    const sessionId = history.sessionId;
    history.saveRun({ type: "run", runId: "run-1", prompt: "hello", status: "started" });
    history.close();
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ version: 1, value: { type: "run", runId: "run-1", prompt: "hello", status: "started" } })}\n{broken`);
    const reopened = DesktopHistory.open(dir, "/tmp/project");
    expect(reopened.snapshot()).toMatchObject({ incomplete: true, corruption: "tail", activeRun: { status: "interrupted" } });
    reopened.close();
  });

  it("redacts key-shaped values before writing recoverable context", () => {
    const dir = temp();
    const history = DesktopHistory.open(dir, "/tmp/project");
    history.saveContext([{ role: "user", content: "api_key=fixture-secret-value" }]);
    const path = join(dir, `${history.sessionId}.jsonl`);
    history.close();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("fixture-secret-value");
    expect(raw).toContain("[REDACTED]");
  });

  it("restores the last project snapshot and model checkpoint without starting a run", async () => {
    const dir = temp();
    const project = join(dir, "project");
    const historyDir = join(dir, "history");
    mkdirSync(project);
    const canonicalProject = realpathSync(project);
    const firstMessages: HostToMain[] = [];
    let calls = 0;
    const first = new HostService({
      send: (message) => firstMessages.push(message),
      historyDirectory: historyDir,
      createAgent: () => { throw new Error("unexpected demo fallback"); },
      createSession: async (_cwd, _provider, _model, prior) => {
        return { provider: "openai", model: "fixture", session: {
          messages: [...(prior ?? []), { role: "user", content: "remember me" }, { role: "assistant", content: "saved answer", toolCalls: [] }],
          subscribe: () => () => {},
          prompt: async (_text, options) => {
            calls += 1;
            if (options.signal.aborted) throw new Error("unexpected cancellation");
          },
        } };
      },
    });
    first.handle({ type: "select-project", requestId: "project", path: project });
    await until(() => firstMessages.some((message) => message.type === "project-selected"));
    first.handle({ type: "start", requestId: "run1", prompt: "save this" });
    await until(() => firstMessages.some((message) => message.type === "runtime-config"));
    await new Promise(setImmediate);
    await first.shutdown();

    const restoredMessages: HostToMain[] = [];
    let resumed: readonly unknown[] | undefined;
    const restored = new HostService({
      send: (message) => restoredMessages.push(message),
      historyDirectory: historyDir,
      createAgent: () => { throw new Error("unexpected demo fallback"); },
      createSession: async (_cwd, _provider, _model, prior) => {
        resumed = prior;
        return { provider: "openai", model: "fixture", session: { messages: prior ?? [], subscribe: () => () => {}, prompt: async () => { calls += 1; } } };
      },
    });
    restored.handle({ type: "initialize", requestId: "boot" });
    expect(restoredMessages[0]).toMatchObject({ type: "initialized", snapshot: { projectPath: canonicalProject, run: { status: "interrupted" } } });
    expect(calls).toBe(1);
    restored.handle({ type: "start", requestId: "resume", prompt: "continue" });
    await until(() => restoredMessages.some((message) => message.type === "runtime-config"));
    expect(JSON.stringify(resumed)).toContain("remember me");
    expect(calls).toBe(2);
    await restored.shutdown();
  });

  it("blocks session construction when saving the accepted run fails", async () => {
    const dir = temp();
    const project = join(dir, "project");
    const historyDir = join(dir, "history");
    mkdirSync(project);
    const messages: HostToMain[] = [];
    let factoryCalls = 0;
    const service = new HostService({
      send: (message) => messages.push(message), historyDirectory: historyDir,
      createAgent: () => { throw new Error("unexpected demo fallback"); },
      createSession: async () => {
        factoryCalls += 1;
        return { provider: "openai", model: "fixture", session: { messages: [], subscribe: () => () => {}, prompt: async () => {} } };
      },
    });
    service.handle({ type: "select-project", requestId: "project", path: project });
    await until(() => messages.some((message) => message.type === "project-selected"));
    const canonical = realpathSync(project);
    const sessionId = `session-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
    rmSync(join(historyDir, `${sessionId}.jsonl`));
    mkdirSync(join(historyDir, `${sessionId}.jsonl`));
    service.handle({ type: "start", requestId: "must-not-run", prompt: "no model call" });
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "history_write_failed" });
    expect(factoryCalls).toBe(0);
    await service.shutdown();
  });

  it("surfaces damaged last-project metadata instead of treating it as empty history", () => {
    const dir = temp();
    writeFileSync(join(dir, "last-project.json"), "{bad metadata");
    const messages: HostToMain[] = [];
    const service = new HostService({ send: (message) => messages.push(message), historyDirectory: dir, createAgent: () => { throw new Error("unused"); } });
    service.handle({ type: "initialize", requestId: "boot" });
    expect(messages[0]).toMatchObject({ type: "initialized", historyNotice: expect.stringContaining("无法恢复上次项目历史") });
    service.handle({ type: "shutdown", requestId: "stop" });
  });

  it("preserves the selected session if another project's history lock is held", async () => {
    const dir = temp();
    const firstPath = join(dir, "first");
    const secondPath = join(dir, "second");
    const historyDir = join(dir, "history");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const canonicalSecond = realpathSync(secondPath);
    const blocker = DesktopHistory.open(historyDir, canonicalSecond);
    const messages: HostToMain[] = [];
    const service = new HostService({ send: (message) => messages.push(message), historyDirectory: historyDir, createAgent: () => { throw new Error("unused"); } });
    service.handle({ type: "select-project", requestId: "first", path: firstPath });
    await until(() => messages.some((message) => message.type === "project-selected" && message.requestId === "first"));
    service.handle({ type: "select-project", requestId: "second", path: secondPath });
    await until(() => messages.some((message) => message.type === "error" && message.requestId === "second"));
    service.handle({ type: "initialize", requestId: "snapshot" });
    expect(messages.at(-1)).toMatchObject({ type: "initialized", snapshot: { projectPath: realpathSync(firstPath) } });
    blocker.close();
    await service.shutdown();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected desktop history operation did not arrive.");
}
