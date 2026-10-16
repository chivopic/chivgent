import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoAgent, FAST_DEMO_TIMING } from "../src/host/demo-agent.js";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";
import { shouldSubmitOnEnter } from "../src/app/input.js";
import { isNearBottom } from "../src/app/scroll.js";
import { initialDeskState, reduceDesk } from "../src/app/reduce.js";
import { validateMainToHost } from "../src/protocol/messages.js";

describe("desktop protocol", () => {
  it("accepts the closed request set and rejects everything else", () => {
    expect(validateMainToHost({ type: "initialize", requestId: "boot" })).toEqual({
      type: "initialize",
      requestId: "boot",
    });
    expect(validateMainToHost({ type: "start", requestId: "a", prompt: "  " })).toBe(
      "prompt must be a non-empty string.",
    );
    expect(validateMainToHost({ type: "explode", requestId: "a" })).toBe(
      "Unknown host request type.",
    );
  });
});

describe("stub agent", () => {
  it("streams text, runs the read-only tool, and completes without writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-demo-"));
    const events: string[] = [];
    const agent = createDemoAgent({
      workspaceRoot: root,
      timing: FAST_DEMO_TIMING,
      onEvent: (event) => events.push(event.type),
    });
    const result = await agent.run("检查一下");
    expect(result.status).toBe("completed");
    expect(events).toContain("message_update");
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
    expect(events.at(-1)).toBe("agent_end");
    expect(readdirSync(root)).toEqual([]);
  });

  it("cancels the in-flight tool through the Agent abort path", async () => {
    const root = mkdtempSync(join(tmpdir(), "chivgent-demo-"));
    const controller = new AbortController();
    const agent = createDemoAgent({
      workspaceRoot: root,
      timing: { textDelayMs: 5, toolDelayMs: 200, finalDelayMs: 5 },
      onEvent: (event) => {
        if (event.type === "tool_execution_start") {
          controller.abort();
        }
      },
    });
    const result = await agent.run("停掉这次", { signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("host service", () => {
  it("correlates requestId and runId, and replays the same start", async () => {
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message),
      createId: () => "fixed",
      createAgent: (onEvent) =>
        createDemoAgent({
          workspaceRoot: mkdtempSync(join(tmpdir(), "chivgent-host-")),
          timing: FAST_DEMO_TIMING,
          onEvent,
        }),
    });
    service.handle({ type: "initialize", requestId: "boot" });
    service.handle({ type: "start", requestId: "req-1", prompt: "你好" });
    await waitFor(() => messages.some((message) => message.type === "event" && message.event.type === "agent_end"));
    service.handle({ type: "start", requestId: "req-1", prompt: "你好" });
    service.handle({ type: "start", requestId: "req-1", prompt: "别的" });

    const started = messages.filter((message) => message.type === "started");
    expect(started[0]).toMatchObject({ requestId: "req-1", runId: "run-fixed", replayed: false });
    expect(started[1]).toMatchObject({ runId: "run-fixed", replayed: true });
    expect(messages.some((message) => message.type === "error" && message.code === "request_conflict")).toBe(true);
    const events = messages.filter((message) => message.type === "event");
    expect(events.every((message) => message.runId === "run-fixed")).toBe(true);
    expect(events.map((message) => message.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it("aborts the active run when interrupt names its runId", async () => {
    const messages: HostToMain[] = [];
    const service = new HostService({
      send: (message) => messages.push(message),
      createId: () => "stop",
      createAgent: (onEvent) =>
        createDemoAgent({
          workspaceRoot: mkdtempSync(join(tmpdir(), "chivgent-host-")),
          timing: { textDelayMs: 5, toolDelayMs: 250, finalDelayMs: 5 },
          onEvent,
        }),
    });
    service.handle({ type: "start", requestId: "req-2", prompt: "停" });
    await waitFor(() =>
      messages.some((message) => message.type === "event" && message.event.type === "tool_execution_start"),
    );
    service.handle({ type: "interrupt", requestId: "int-1", runId: "run-stop" });
    await waitFor(() =>
      messages.some((message) => message.type === "event" && message.event.type === "agent_end"),
    );
    const end = messages.find((message) => message.type === "event" && message.event.type === "agent_end");
    expect(end && end.type === "event" && end.event.status).toBe("aborted");
    expect(messages).toContainEqual({
      type: "interrupted",
      requestId: "int-1",
      runId: "run-stop",
      accepted: true,
    });
  });
});

describe("composer and scroll", () => {
  it("does not submit while an IME composition is confirming", () => {
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      ignoreEnter: false,
    })).toBe(true);
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 229,
      ignoreEnter: false,
    })).toBe(false);
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      ignoreEnter: true,
    })).toBe(false);
    expect(shouldSubmitOnEnter({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
      ignoreEnter: false,
    })).toBe(false);
  });

  it("keeps the reader in place when they have scrolled up", () => {
    expect(isNearBottom({ scrollHeight: 400, scrollTop: 360, clientHeight: 40 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 800, scrollTop: 20, clientHeight: 200 })).toBe(false);
  });

  it("marks an in-flight run unknown when the host exits", () => {
    const running = reduceDesk(
      { ...initialDeskState, phase: "running", runId: "run-1" },
      { type: "host", status: { phase: "exited", message: "Agent host 已退出。进行中的运行结果未知。" } },
    );
    expect(running.phase).toBe("error");
    expect(running.notice).toContain("结果未知");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5_000) {
      throw new Error("timed out waiting for host output");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
