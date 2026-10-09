import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerShellConfig } from "../src/shell/docker.js";
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
    expect(flags).toContain(`type=bind,source=${root},target=/workspace`);
    expect(flags).not.toContain("/var/run/docker.sock");
    expect(flags).not.toContain("--privileged");
    expect(flags).not.toContain("--network host");
    expect(cfg.args.filter(arg => arg === "--mount")).toHaveLength(1);
  });

  it("allows no untrusted Docker image that looks like another option", async () => {
    const root = await cwd();
    expect(() => dockerShellConfig(root, { image: "--privileged" })).toThrow();
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
});
