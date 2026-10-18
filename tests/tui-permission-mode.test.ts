import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/session.js";
import { PermissionPolicy, PermissionWorkspace } from "../src/permissions.js";
import { WriteFileTool } from "../src/tools/write-file.js";
import { ShellApprovalGate } from "../src/shell/approval.js";
import { runRepl } from "../src/repl.js";
import { createLiveRegion } from "../src/tui/live.js";
import { assistant } from "./fakes.js";
import { terminalHarness } from "./helpers/terminal.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("TUI permission mode shortcut", () => {
  it("cycles the real session policy and keeps Plan, Auto, Ask, busy, and approval behavior", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const cwd = await mkdtemp(path.join(tmpdir(), "chivgent-tui-permissions-"));
    roots.push(cwd);
    const screen = terminalHarness(80, 24);
    const gate = new ShellApprovalGate();
    const policy = new PermissionPolicy("ask-first");
    policy.setApproval((action, signal, context) => gate.approve(action, signal, context));

    let activePrompt = "";
    let stage = 0;
    let toolCount = 0;
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>(resolve => { slowStarted = resolve; });
    let releaseSlow!: () => void;
    const slowWait = new Promise<void>(resolve => { releaseSlow = resolve; });
    const session = new AgentSession({ cwd, agent: {
      systemPrompt: "test", maxTurns: 2, tools: [new WriteFileTool()],
      workspace: new PermissionWorkspace(cwd, policy), streaming: false,
      llm: { async complete(request) {
        const user = [...request.messages].reverse().find(message => message.role === "user")?.content ?? "";
        if (user !== activePrompt) { activePrompt = user; stage = 0; }
        if (activePrompt === "slow") {
          slowStarted();
          await slowWait;
          return assistant("done");
        }
        if (stage++ === 0) {
          const pathByPrompt: Record<string, string> = {
            "write-plan": "plan.txt", "write-auto": "auto.txt", "write-ask": "ask.txt",
          };
          const target = pathByPrompt[activePrompt];
          if (target === undefined) return assistant("done");
          return assistant("", [{
            id: `write-${++toolCount}`, name: "write_file",
            arguments: { path: target, contents: `${activePrompt} contents` },
          }]);
        }
        return assistant("done");
      } },
    } });
    const region = createLiveRegion({ stream: screen.output, width: () => screen.output.columns, height: () => screen.output.rows });
    session.subscribe(region.listener);
    const repl = runRepl({
      session, ...screen, stderr: screen.output, tui: true, inlineComposer: true,
      permissionPolicy: policy, shellApproval: gate, liveRegion: region,
    });
    const completedAnswers = async (count: number): Promise<void> => {
      await vi.waitFor(() => expect(session.messages.filter(message => message.role === "assistant" && message.content === "done")).toHaveLength(count));
    };

    try {
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me"));
      expect(screen.visible().join("\n")).toContain("Ask for me · Shift+Tab Plan · /help");
      screen.input.write("/help\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Shift+Tab cycles Plan → Auto mode → Ask for me"));

      screen.input.write("write-plan");
      screen.input.write("\u001b[Z");
      await vi.waitFor(() => expect(session.planMode).toBe(true));
      await screen.flush();
      expect(screen.visible().join("\n")).toContain("write-plan");
      expect(screen.visible().join("\n")).toContain("Plan");
      screen.input.write("\r");
      await completedAnswers(1);
      expect(session.messages.some(message => message.role === "tool" && message.isError && message.content.includes("Plan Mode blocked"))).toBe(true);
      await expect(readFile(path.join(cwd, "plan.txt"), "utf8")).rejects.toThrow();

      screen.input.write("\u001b[Z");
      await vi.waitFor(() => {
        expect(session.planMode).toBe(false);
        expect(policy.mode).toBe("workspace");
      });
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Auto mode"));
      screen.input.write("write-auto\r");
      await vi.waitFor(async () => expect(await readFile(path.join(cwd, "auto.txt"), "utf8")).toBe("write-auto contents"));
      await completedAnswers(2);
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Auto mode"));

      screen.input.write("\u001b[Z");
      await vi.waitFor(() => expect(policy.mode).toBe("ask-first"));
      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me"));
      screen.input.write("write-ask\r");
      await vi.waitFor(() => expect(screen.bytes()).toContain("Approve once?"));
      screen.input.write("\u001b[Z");
      await completedAnswers(3);
      expect(policy.mode).toBe("ask-first");
      expect(session.planMode).toBe(false);
      await expect(readFile(path.join(cwd, "ask.txt"), "utf8")).rejects.toThrow();

      screen.input.write("slow\r");
      await slowStartedPromise;
      screen.input.write("\u001b[Z");
      expect(policy.mode).toBe("ask-first");
      expect(session.planMode).toBe(false);
      releaseSlow();
      await completedAnswers(4);
      expect(policy.mode).toBe("ask-first");

      await vi.waitFor(() => expect(screen.visible().join("\n")).toContain("Ask for me"));
      screen.input.write("\u0004");
      await expect(repl).resolves.toBe(0);
      expect(screen.input.raw).toBe(false);
    } finally {
      releaseSlow();
      screen.input.end();
      region.stop();
      await repl;
      screen.dispose();
    }
  }, 15_000);
});
