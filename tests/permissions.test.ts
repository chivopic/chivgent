import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialPermissionMode, PermissionPolicy, PermissionWorkspace } from "../src/permissions.js";
import { BashTool } from "../src/tools/bash.js";
import type { ShellOperations } from "../src/shell/types.js";
import { AgentSession } from "../src/session.js";
import { FileSessionStore } from "../src/session-store.js";
import { assistant, FakeLLMClient } from "./fakes.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "chivgent-permissions-"));
  roots.push(value);
  return value;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("initial TUI permission selection", () => {
  const ordinaryTui = {
    interactive: true, tui: true, allowWrites: false, allowShell: false,
    approveAllShell: false, shellNetwork: false,
  } as const;

  it("starts an ordinary interactive TUI in Ask for me", () => {
    expect(initialPermissionMode(ordinaryTui)).toBe("ask-first");
  });

  it("keeps non-TUI and non-interactive sessions on the legacy read-only path", () => {
    expect(initialPermissionMode({ ...ordinaryTui, tui: false })).toBeUndefined();
    expect(initialPermissionMode({ ...ordinaryTui, interactive: false })).toBeUndefined();
  });

  it.each([
    ["allowWrites", { allowWrites: true }],
    ["allowShell", { allowShell: true }],
    ["approveAllShell", { approveAllShell: true }],
    ["shellNetwork", { shellNetwork: true }],
  ] as const)("does not override the explicit legacy %s capability", (_name, change) => {
    expect(initialPermissionMode({ ...ordinaryTui, ...change })).toBeUndefined();
  });

  it.each(["ask-first", "workspace", "unrestricted"] as const)("respects explicit --permission-mode %s", permissionMode => {
    expect(initialPermissionMode({ ...ordinaryTui, permissionMode })).toBe(permissionMode);
  });

  it("does not persist a broader process policy in the session record", async () => {
    const cwd = await root();
    const store = new FileSessionStore(await root());
    const agent = {
      systemPrompt: "test", maxTurns: 1, llm: new FakeLLMClient([]), tools: [],
      workspace: new PermissionWorkspace(cwd, new PermissionPolicy("unrestricted")), streaming: false,
    };
    const session = new AgentSession({ agent, cwd, store });
    await session.initialize();
    const saved = await store.read(session.id);
    expect(saved).toBeDefined();
    expect(saved).not.toHaveProperty("permissionMode");
    expect(initialPermissionMode(ordinaryTui)).toBe("ask-first");
  });
});

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
      supportedScopes: ["workspace", "host"],
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
  it("authorizes network-only scope in workspace mode without host file access", async () => {
    const cwd = await root();
    const askedContexts: (string | undefined)[] = [];
    const policy = new PermissionPolicy("workspace", async (_cmd, _sig, ctx) => {
      askedContexts.push(ctx);
      return true;
    });
    const scopes: string[] = [];
    const exec = vi.fn(async (_cmd: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from("downloaded"));
      return { exitCode: 0 };
    });
    const operations: ShellOperations = { backend: "Docker (network enabled, workspace writes enabled)", exec };
    const tool = new BashTool({
      cwd,
      supportedScopes: ["workspace", "network"],
      operationsForCall: (scope) => { scopes.push(scope ?? "workspace"); return operations; },
      authorize: (req) => policy.authorizeShell(req.command, req.scope, req.signal, req.justification ? `Reason requested by model: ${req.justification}` : undefined),
    });
    const output = await tool.execute({ command: "npm install", scope: "network", justification: "Download dependencies" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(false);
    expect(scopes).toEqual(["network"]);
    expect(exec).toHaveBeenCalledOnce();
    expect(askedContexts[0]).toContain("Network access for this command only");
    expect(askedContexts[0]).not.toContain("Expanded host access");
  });

  it("executes normal workspace commands in workspace mode with zero prompts", async () => {
    const cwd = await root();
    const approve = vi.fn(async () => true);
    const policy = new PermissionPolicy("workspace", approve);
    const exec = vi.fn(async (_cmd: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from("clean workspace run"));
      return { exitCode: 0 };
    });
    const tool = new BashTool({
      cwd,
      operationsForCall: () => ({ backend: "Docker (network denied, workspace writes enabled)", networkAccess: false, exec }),
      authorize: (req) => policy.authorizeShell(req.command, req.scope, req.signal),
    });
    const output = await tool.execute({ command: "pwd" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(false);
    expect(exec).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
  });

  it("prompts before workspace commands in ask-first mode and denies on rejection", async () => {
    const cwd = await root();
    const approve = vi.fn().mockResolvedValueOnce(false);
    const policy = new PermissionPolicy("ask-first", approve);
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const tool = new BashTool({
      cwd,
      operationsForCall: () => ({ backend: "Docker (network denied, workspace writes enabled)", networkAccess: false, exec }),
      authorize: (req) => policy.authorizeShell(req.command, req.scope, req.signal),
    });
    const output = await tool.execute({ command: "pwd" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(true);
    expect(output.content).toBe("Shell command denied by user.");
    expect(approve).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects network scope without justification before invoking approval", async () => {
    const cwd = await root();
    const approve = vi.fn(async () => true);
    const policy = new PermissionPolicy("workspace", approve);
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const tool = new BashTool({
      cwd,
      supportedScopes: ["workspace", "network"],
      operationsForCall: () => ({ backend: "Docker (network enabled, workspace writes enabled)", exec }),
      authorize: (req) => policy.authorizeShell(req.command, req.scope, req.signal),
    });
    const output = await tool.execute({ command: "npm install", scope: "network" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("diagnoses network failure when network is disabled in the active sandbox", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace");
    const exec = vi.fn(async (_cmd: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from("curl: (6) Could not resolve host: example.com\n"));
      return { exitCode: 6 };
    });
    const tool = new BashTool({
      cwd,
      supportedScopes: ["workspace", "network"],
      operationsForCall: () => ({ backend: "Docker (network denied, workspace writes enabled)", networkAccess: false, exec }),
      authorize: (req) => policy.authorizeShell(req.command, req.scope, req.signal),
    });
    const output = await tool.execute({ command: "curl https://example.com" }, {
      workspace: new PermissionWorkspace(cwd, policy),
    });
    expect(output.isError).toBe(true);
    expect(output.content).toContain("network access is disabled in the active sandbox");
    expect(output.content).toContain('request bash with scope "network"');
  });

  it.each([
    ["Operation not permitted", "native (Seatbelt, workspace file access), network denied", false],
    ["Could not resolve host: example.com", undefined, undefined],
    ["Could not resolve host: example.com", "Docker (network denied)", true],
  ])("uses explicit network capability metadata for failure hints", async (message, backend, networkAccess) => {
    const cwd = await root();
    const exec = vi.fn(async (_cmd: string, _cwd: string, options: { onData: (chunk: Buffer) => void }) => {
      options.onData(Buffer.from(`${message}\n`));
      return { exitCode: 1 };
    });
    const tool = new BashTool({
      cwd,
      operations: { ...(backend === undefined ? {} : { backend }), ...(networkAccess === undefined ? {} : { networkAccess }), exec },
      approve: async () => true,
    });
    const output = await tool.execute({ command: "curl https://example.com" }, {
      workspace: new PermissionWorkspace(cwd, new PermissionPolicy("workspace")),
    });
    expect(output.content).toContain("Command exited with code 1");
    expect(output.content).not.toContain("network access is disabled");
    expect(output.content).not.toContain('scope "network"');
  });

  it("does not carry one-command network access into the next workspace call", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace", async () => true);
    const scopes: string[] = [];
    const networkExec = vi.fn(async () => ({ exitCode: 0 }));
    const workspaceExec = vi.fn(async () => ({ exitCode: 0 }));
    const tool = new BashTool({
      cwd,
      supportedScopes: ["workspace", "network", "host"],
      operationsForCall: scope => {
        scopes.push(scope ?? "workspace");
        return scope === "network"
          ? { networkAccess: true, exec: networkExec }
          : { networkAccess: false, exec: workspaceExec };
      },
      authorize: request => policy.authorizeShell(request.command, request.scope, request.signal),
    });
    const context = { workspace: new PermissionWorkspace(cwd, policy) };
    expect((await tool.execute({ command: "curl https://example.com", scope: "network", justification: "Fetch an asset" }, context)).isError).toBe(false);
    expect((await tool.execute({ command: "pwd" }, context)).isError).toBe(false);
    expect(scopes).toEqual(["network", "workspace"]);
    expect(networkExec).toHaveBeenCalledOnce();
    expect(workspaceExec).toHaveBeenCalledOnce();
  });

  it("does not run a host command when approval is rejected", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace", async () => false);
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const operations: ShellOperations = { backend: "native (test sandbox)", exec };
    const tool = new BashTool({
      cwd,
      supportedScopes: ["workspace", "host"],
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
      supportedScopes: ["workspace", "host"],
      operationsForCall: (scope) => { scopes.push(scope ?? "workspace"); return { backend: "native (test sandbox)", exec }; },
      defaultScopeForCall: () => "host",
      approve: (command, signal, context) => policy.authorizeShell(command, context?.startsWith("Expanded host access") ? "host" : "workspace", signal, context),
    });
    const output = await tool.execute({ command: "echo unrestricted" }, { workspace: new PermissionWorkspace(cwd, policy) });
    expect(output.isError).toBe(false);
    expect(scopes).toEqual(["host"]);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("asks for each web search with the exact query and provider", async () => {
    const approval = vi.fn(async () => true);
    const policy = new PermissionPolicy("workspace", approval);
    await expect(policy.authorizeWebSearch("node 24 release notes", "searxng (search.example)")).resolves.toBe(true);
    expect(approval).toHaveBeenCalledWith(
      "node 24 release notes",
      undefined,
      "Web search via searxng (search.example)",
    );
  });

  it("denies web search without an approval channel in ask-first and workspace", async () => {
    for (const mode of ["ask-first", "workspace"] as const) {
      const policy = new PermissionPolicy(mode);
      await expect(policy.authorizeWebSearch("q", "searxng (search.example)")).resolves.toBe(false);
    }
  });

  it("allows web search in unrestricted mode without prompting", async () => {
    const approval = vi.fn(async () => false);
    const policy = new PermissionPolicy("unrestricted", approval);
    await expect(policy.authorizeWebSearch("q", "searxng (search.example)")).resolves.toBe(true);
    expect(approval).not.toHaveBeenCalled();
  });

  it("does not approve a web search that completes after cancellation", async () => {
    const controller = new AbortController();
    const approval = vi.fn(async (_query: string, signal?: AbortSignal) => {
      controller.abort();
      return signal?.aborted !== true;
    });
    const policy = new PermissionPolicy("ask-first", approval);
    await expect(policy.authorizeWebSearch("q", "searxng (search.example)", controller.signal)).resolves.toBe(false);
    expect(approval).toHaveBeenCalledOnce();
  });

  it("rejects a default scope the executor does not support", async () => {
    const cwd = await root();
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const approve = vi.fn(async () => true);
    const tool = new BashTool({
      cwd,
      operations: { exec },
      supportedScopes: ["workspace"],
      defaultScopeForCall: () => "host",
      approve,
    });
    const output = await tool.execute({ command: "printf safe" }, {
      workspace: new PermissionWorkspace(cwd, new PermissionPolicy("unrestricted")),
    });
    expect(output.isError).toBe(true);
    expect(output.content).toContain('scope "host" is unavailable');
    expect(approve).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not cache a one-command host approval for the next command", async () => {
    const cwd = await root();
    const policy = new PermissionPolicy("workspace");
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const approve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const tool = new BashTool({ cwd, supportedScopes: ["workspace", "host"], operations: { backend: "native (test sandbox)", exec }, approve });
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
