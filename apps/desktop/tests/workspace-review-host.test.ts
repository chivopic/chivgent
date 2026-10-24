import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const run = promisify(execFile);

describe("workspace review host request", () => {
  it("returns the selected project's Git workspace review", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "review-host-")));
    roots.push(project);
    await run("git", ["init", "-q"], { cwd: project });
    const messages: HostToMain[] = [];
    const host = new HostService({ send: (message) => messages.push(message), createAgent: () => { throw new Error("unused"); } });
    host.handle({ type: "select-project", requestId: "select", path: project });
    await until(() => messages.some((message) => message.type === "project-selected"));
    host.handle({ type: "workspace-review", requestId: "review", projectPath: project });
    await until(() => messages.some((message) => message.type === "workspace-review" || (message.type === "error" && message.requestId === "review")));
    expect(messages).toContainEqual(expect.objectContaining({ type: "workspace-review", requestId: "review", projectPath: project, review: expect.objectContaining({ kind: "git", staged: "", unstaged: "", untracked: [] }) }));
    await host.shutdown();
  });

  it("rejects a late review request for a project that is no longer selected", async () => {
    const first = realpathSync(mkdtempSync(join(tmpdir(), "review-old-")));
    const second = realpathSync(mkdtempSync(join(tmpdir(), "review-new-")));
    roots.push(first, second);
    await run("git", ["init", "-q"], { cwd: first }); await run("git", ["init", "-q"], { cwd: second });
    const messages: HostToMain[] = [];
    const host = new HostService({ send: (message) => messages.push(message), createAgent: () => { throw new Error("unused"); } });
    host.handle({ type: "select-project", requestId: "select-first", path: first });
    await until(() => messages.some((message) => message.type === "project-selected" && message.path === first));
    host.handle({ type: "select-project", requestId: "select-second", path: second });
    await until(() => messages.some((message) => message.type === "project-selected" && message.path === second));
    host.handle({ type: "workspace-review", requestId: "late", projectPath: first });
    await until(() => messages.some((message) => message.type === "error" && message.requestId === "late"));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", requestId: "late", code: "project_mismatch" }));
    await host.shutdown();
  });

  it("does not forward Git diagnostics or local paths to the renderer", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "review-error-")));
    roots.push(project);
    await run("git", ["init", "-q"], { cwd: project });
    writeFileSync(join(project, ".git", "config"), "invalid config content\n");
    const messages: HostToMain[] = [];
    const host = new HostService({ send: (message) => messages.push(message), createAgent: () => { throw new Error("unused"); } });
    host.handle({ type: "select-project", requestId: "select", path: project });
    await until(() => messages.some((message) => message.type === "project-selected"));
    host.handle({ type: "workspace-review", requestId: "review-error", projectPath: project });
    await until(() => messages.some((message) => message.type === "error" && message.requestId === "review-error"));
    const error = messages.find((message) => message.type === "error" && message.requestId === "review-error");
    expect(error).toMatchObject({ type: "error", code: "workspace_review_failed", message: "Unable to read workspace changes." });
    expect(JSON.stringify(error)).not.toContain(project);
    await host.shutdown();
  });

  it("reports a deleted selected workspace as a read failure, not as non-Git", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "review-missing-")));
    roots.push(project);
    await run("git", ["init", "-q"], { cwd: project });
    const messages: HostToMain[] = [];
    const host = new HostService({ send: (message) => messages.push(message), createAgent: () => { throw new Error("unused"); } });
    host.handle({ type: "select-project", requestId: "select", path: project });
    await until(() => messages.some((message) => message.type === "project-selected"));
    rmSync(project, { recursive: true, force: true });
    host.handle({ type: "workspace-review", requestId: "review-missing", projectPath: project });
    await until(() => messages.some((message) => message.type === "error" && message.requestId === "review-missing"));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", requestId: "review-missing", code: "workspace_review_failed", message: "Unable to resolve workspace path." }));
    expect(JSON.stringify(messages.find((message) => message.type === "error" && message.requestId === "review-missing"))).not.toContain(project);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "workspace-review", requestId: "review-missing", review: { kind: "not-git" } }));
    await host.shutdown();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
