import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionPolicy, PermissionWorkspace } from "../src/permissions.js";
import { BashTool } from "../src/tools/bash.js";
import type { ShellOperations } from "../src/shell/types.js";
import { AgentSession } from "../src/session.js";
import { assistant, FakeLLMClient } from "./fakes.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "chivgent-permissions-"));
  roots.push(value);
  return value;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("permission policy", () => {
  it("asks before each ask-first file change and does not mutate on denial", async () => {
    const cwd = await root();
    const approval = vi.fn(async () => false);
    const workspace = new PermissionWorkspace(cwd, new PermissionPolicy("ask-first", approval));
    await expect(workspace.writeTextFile("denied.txt", "no")).rejects.toThrow(/denied/i);
    await expect(stat(path.join(cwd, "denied.txt"))).rejects.toThrow();
    expect(approval).toHaveBeenCalledOnce();
  });

  it("checks cancellation after an approval resolves", async () => {
    const cwd = await root();
    const controller = new AbortController();
    const approval = vi.fn(async (_action: string, signal?: AbortSignal) => {
      controller.abort();
      return signal?.aborted === true;
    });
    const workspace = new PermissionWorkspace(cwd, new PermissionPolicy("ask-first", approval));
    await expect(workspace.writeTextFile("cancelled.txt", "no", controller.signal)).rejects.toThrow(/denied/i);
    await expect(stat(path.join(cwd, "cancelled.txt"))).rejects.toThrow();
  });

  it("writes automatically within workspace mode", async () => {
    const cwd = await root();
    const workspace = new PermissionWorkspace(cwd, new PermissionPolicy("workspace"));
    await workspace.writeTextFile("allowed.txt", "yes");
    expect(await readFile(path.join(cwd, "allowed.txt"), "utf8")).toBe("yes");
  });

  it("applies a /permissions mode change to the same session workspace policy", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("ask-first", async () => false);
    const workspace = new PermissionWorkspace(cwd, policy);
    await expect(workspace.writeTextFile("before.txt", "denied")).rejects.toThrow();
    policy.setMode("workspace");
    await workspace.writeTextFile("after.txt", "allowed");
    expect(await readFile(path.join(cwd, "after.txt"), "utf8")).toBe("allowed");
  });

  it("requires one explicit approval for a workspace-mode host shell request", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace", async () => true);
    const scopes: string[] = [];
    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from("ran"));
      return { exitCode: 0 };
    });
    const operations: ShellOperations = { backend: "native (test sandbox)", exec };
    const tool = new BashTool({
      cwd,
      operationsForCall: (scope) => { scopes.push(scope ?? "workspace"); return operations; },
      approve: (command, signal, context) => policy.authorizeShell(command, context?.startsWith("Expanded host access") ? "host" : "workspace", signal, context),
    });
    const output = await tool.execute({ command: "cat /tmp/outside", scope: "host", justification: "Read an explicit external fixture" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(false);
    expect(scopes).toEqual(["host"]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("does not run a host command when approval is rejected", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace", async () => false);
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const operations: ShellOperations = { backend: "native (test sandbox)", exec };
    const tool = new BashTool({
      cwd,
      operationsForCall: () => operations,
      approve: (command, signal, context) => policy.authorizeShell(command, context?.startsWith("Expanded host access") ? "host" : "workspace", signal, context),
    });
    const output = await tool.execute({ command: "cat /tmp/outside", scope: "host", justification: "Read a file" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs ordinary commands in explicitly selected unrestricted mode without a justification", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("unrestricted");
    const scopes: string[] = [];
    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from("ran"));
      return { exitCode: 0 };
    });
    const tool = new BashTool({
      cwd,
      operationsForCall: (scope) => { scopes.push(scope ?? "workspace"); return { backend: "native (test sandbox)", exec }; },
      defaultScopeForCall: () => "host",
      approve: (command, signal, context) => policy.authorizeShell(command, context?.startsWith("Expanded host access") ? "host" : "workspace", signal, context),
    });
    const output = await tool.execute({ command: "echo unrestricted" }, { workspace: new PermissionWorkspace(cwd, policy) });
    expect(output.isError).toBe(false);
    expect(scopes).toEqual(["host"]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("does not cache a one-command host approval for the next command", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace");
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const approve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const tool = new BashTool({ cwd, operations: { backend: "native (test sandbox)", exec }, approve });
    const context = { workspace: new PermissionWorkspace(cwd, policy) };
    expect((await tool.execute({ command: "first", scope: "host", justification: "First request" }, context)).isError).toBe(false);
    expect((await tool.execute({ command: "second", scope: "host", justification: "Second request" }, context)).isError).toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("keeps Plan Mode read-only even with unrestricted permissions", async () => {
    let ran = false;
    const session = new AgentSession({
      agent: {
        systemPrompt: "test", maxTurns: 1,
        llm: new FakeLLMClient([assistant("", [{ id: "c1", name: "danger", arguments: {} }]), assistant("done")]),
        tools: [{ name: "danger", description: "mutating test tool", inputSchema: { type: "object" }, async execute() { ran = true; return { content: "ran", isError: false }; } }],
        workspace: new PermissionWorkspace(await root(), new PermissionPolicy("unrestricted")), streaming: false,
      },
    });
    await session.setPlanMode(true);
    await session.prompt("Do the dangerous action");
    expect(ran).toBe(false);
    expect(session.messages.some((message) => message.role === "tool" && message.isError && message.content.includes("Plan Mode blocked"))).toBe(true);
  });
});
