import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerShellConfig } from "../src/shell/docker.js";
import { createShellOperations } from "../src/shell/factory.js";
import { ShellApprovalGate } from "../src/shell/approval.js";
import { BashTool } from "../src/tools/bash.js";
import type { ShellOperations } from "../src/shell/types.js";
import type { Workspace } from "../src/workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
async function cwd() {
  const p = await mkdtemp(path.join(tmpdir(), "chivgent-docker-test-"));
  dirs.push(p);
  return p;
}
const workspace = {} as Workspace;

describe("Docker shell isolation", () => {
  it("uses no network, only workspace bind mount, read-only root and low privileges", async () => {
    const root = await cwd();
    const cfg = dockerShellConfig(root);
    const flags = cfg.args.join(" ");
    expect(cfg.shell).toBe("docker");
    expect(cfg.args.slice(-3)).toEqual(["node:22-alpine", "sh", "-c"]);
    expect(flags).toContain("--network none");
    expect(flags).toContain("--read-only");
    expect(flags).toContain("--cap-drop ALL");
    expect(flags).toContain("--security-opt no-new-privileges");
    expect(flags).toContain("--pids-limit 64");
    expect(flags).toContain("--memory 512m");
    expect(flags).toContain("--workdir /workspace");
    expect(flags).toContain(`type=bind,source=${realpathSync(root)},target=/workspace,readonly`);
    expect(flags).not.toContain("/var/run/docker.sock");
    expect(flags).not.toContain("--privileged");
    expect(flags).not.toContain("--network host");
    expect(cfg.args.filter(arg => arg === "--mount")).toHaveLength(1);
    const writeEnabled = dockerShellConfig(root, { allowWrites: true });
    const writeFlags = writeEnabled.args.join(" ");
    expect(writeFlags).not.toContain(`source=${realpathSync(root)},target=/workspace,readonly`);
    expect(writeFlags).toContain("--network none");
    for (const name of [".git", ".agents", ".codex", ".aws", ".ssh"]) {
      expect(writeFlags).toContain(`--tmpfs /workspace/${name}:ro,nosuid,nodev,size=1m`);
    }
  });

  it("allows no untrusted Docker image that looks like another option", async () => {
    const root = await cwd();
    expect(() => dockerShellConfig(root, { image: "--privileged" })).toThrow();
  });

  it("bind-mounts sensitive entries read-only when they already exist", async () => {
    const root = await cwd();
    await mkdir(path.join(root, ".ssh"));
    const cfg = dockerShellConfig(root, { allowWrites: true });
    const flags = cfg.args.join(" ");
    expect(flags).toContain(`source=${realpathSync(root)}/.ssh,target=/workspace/.ssh,readonly`);
    expect(flags).not.toContain("--tmpfs /workspace/.ssh:ro,nosuid,nodev,size=1m");
  });

  it("denies all commands unless someone explicitly approves", async () => {
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const operations: ShellOperations = { exec: run };
    const tool = new BashTool({ cwd: await cwd(), operations });
    const result = await tool.execute({ command: "echo hello" }, { workspace });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/approval is required/);
    expect(run).not.toHaveBeenCalled();
  });

  it("asks for each command, and denial never invokes the executor", async () => {
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const gate = new ShellApprovalGate();
    const asked: string[] = [];
    gate.setHandler(async (command) => {
      asked.push(command);
      return command === "echo allowed";
    });
    const tool = new BashTool({ cwd: await cwd(), operations: { exec: run }, approve: (cmd, signal) => gate.approve(cmd, signal) });
    const denied = await tool.execute({ command: "echo rejected" }, { workspace });
    expect(denied.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();

    const accepted = await tool.execute({ command: "echo allowed" }, { workspace });
    expect(accepted.isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(["echo rejected", "echo allowed"]);
  });

  it("does not run commands after a cancellation while awaiting approval", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const gate = new ShellApprovalGate();
    gate.setHandler(async () => { controller.abort(); return true; });
    const tool = new BashTool({ cwd: await cwd(), operations: { exec: run }, approve: (cmd, signal) => gate.approve(cmd, signal) });
    await expect(tool.execute({ command: "echo hello" }, { workspace, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });

  it("headless sessions deny by default and approve-all is explicit", async () => {
    expect(await new ShellApprovalGate().approve("rm file")).toBe(false);
    expect(await new ShellApprovalGate(true).approve("echo ok")).toBe(true);
  });
  it("supports network escalation without host file mounts", async () => {
    const root = await cwd();
    const cfg = dockerShellConfig(root, { allowWrites: true, allowNetwork: true });
    const flags = cfg.args.join(" ");
    expect(flags).toContain("--network bridge");
    expect(flags).not.toContain("--network none");
    expect(flags).toContain(`type=bind,source=${realpathSync(root)},target=/workspace`);
    expect(cfg.args.filter(arg => arg === "--mount")).toHaveLength(1);
  });

  it("fails closed with a clear diagnostic when host access is requested in Docker", async () => {
    const root = await cwd();
    const tool = new BashTool({
      cwd: root,
      operationsForCall: () => createShellOperations({ backend: "docker", allowHostAccess: true }),
      approve: async () => true,
    });
    const output = await tool.execute({ command: "cat /etc/shadow", scope: "host", justification: "Test host access" }, { workspace });
    expect(output.isError).toBe(true);
    expect(output.content).toContain("Host access is unavailable in the Docker shell backend; no command was run.");
  });
});
