import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoAgent, FAST_DEMO_TIMING } from "../src/host/demo-agent.js";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";
import { shouldSubmitOnEnter } from "../src/app/input.js";
import { isNearBottom } from "../src/app/scroll.js";
import { initialDeskState, reduceDesk, type DeskAction } from "../src/app/reduce.js";
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
    expect(validateMainToHost({ type: "start", requestId: "a", prompt: "x", model: "  " })).toBe("model must be 1-160 non-empty characters.");
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
  it("settles partial text on cancellation and host failure without losing the text", () => {
    const streaming = reduceDesk(
      { ...initialDeskState, phase: "running", runId: "run-1" },
      { type: "agent", runId: "run-1", sequence: 1, event: { type: "message_update", turn: 1, delta: "未完成的回答" } },
    );
    const stopped = reduceDesk(streaming, {
      type: "agent", runId: "run-1", sequence: 2, event: { type: "agent_end", status: "aborted" },
    });
    expect(stopped.phase).toBe("stopped");
    expect(stopped.items[0]).toMatchObject({ text: "未完成的回答", streaming: false });
    const crashed = reduceDesk(streaming, { type: "host", status: { phase: "exited" } });
    expect(crashed.phase).toBe("error");
    expect(crashed.items[0]).toMatchObject({ text: "未完成的回答", streaming: false });
    const cancelled = reduceDesk(streaming, { type: "cancelled" });
    expect(cancelled.phase).toBe("stopped");
    expect(cancelled.items[0]).toMatchObject({ text: "未完成的回答", streaming: false });
  });

  it("does not let stale run events or late acknowledgements overwrite the active run", () => {
    const active = { ...initialDeskState, phase: "running" as const, runId: "run-new" };
    const staleEnd = reduceDesk(active, { type: "agent", runId: "run-old", sequence: 9, event: { type: "agent_end", status: "aborted" } });
    expect(staleEnd).toEqual(active);
    const staleError = reduceDesk(active, { type: "run-error", runId: "run-old", message: "old run failed" } as Parameters<typeof reduceDesk>[1]);
    expect(staleError).toEqual(active);
    const complete = reduceDesk(active, { type: "agent", runId: "run-new", sequence: 1, event: { type: "agent_end", status: "completed" } });
    expect(complete.phase).toBe("completed");
    expect(reduceDesk(complete, { type: "started", runId: "run-new" }).phase).toBe("completed");
    expect(reduceDesk(active, { type: "run-error", runId: "run-new", message: "current failed" } as Parameters<typeof reduceDesk>[1]).phase).toBe("error");
  });

  it("discards a duplicate sequence without appending its delta twice", () => {
    const active = { ...initialDeskState, phase: "running" as const, runId: "run-duplicate" };
    const first = reduceDesk(active, { type: "agent", runId: "run-duplicate", sequence: 1, event: { type: "message_update", turn: 1, delta: "once" } });
    const duplicate = reduceDesk(first, { type: "agent", runId: "run-duplicate", sequence: 1, event: { type: "message_update", turn: 1, delta: "once" } });
    expect(duplicate.items).toEqual([{ kind: "assistant", id: "assistant-run-duplicate-1", runId: "run-duplicate", turn: 1, text: "once", streaming: true }]);
    expect(duplicate).toBe(first);
  });

  it("hydrates an interrupted tool as unknown and never treats it as completed", () => {
    const restored = reduceDesk(initialDeskState, { type: "hydrate", snapshot: {
      hostInstanceId: "host-restored", sessionId: "session-restored", projectPath: "/tmp/project", sequence: 1,
      runs: [{ runId: "run-restored", prompt: "inspect", status: "interrupted" }],
      run: { runId: "run-restored", prompt: "inspect", status: "interrupted" },
      events: [{ runId: "run-restored", sequence: 1, event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read_file" } }],
      incomplete: false, corruption: null,
    } });
    expect(restored.phase).toBe("error");
    expect(restored.items).toContainEqual(expect.objectContaining({ kind: "tool", status: "unknown", output: "执行结果未知，需要检查工作区。" }));
    expect(restored.notice).toContain("没有自动重放工具");
  });

  it("marks only the active run's unfinished tools unknown when the host exits or fails", () => {
    let state = reduceDesk({ ...initialDeskState, host: { phase: "ready" } }, { type: "submit", text: "检查项目" });
    state = reduceDesk(state, { type: "started", runId: "run-active" });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 1, event: { type: "message_update", turn: 1, delta: "部分回答" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 2, event: { type: "tool_execution_start", toolCallId: "running", toolName: "read_file" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 3, event: { type: "tool_execution_update", toolCallId: "running", content: "已读到一部分" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 4, event: { type: "tool_execution_start", toolCallId: "done", toolName: "list_files" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 5, event: { type: "tool_execution_end", toolCallId: "done", content: "完成的输出" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 6, event: { type: "tool_execution_start", toolCallId: "failed", toolName: "search_text" } });
    state = reduceDesk(state, { type: "agent", runId: "run-active", sequence: 7, event: { type: "tool_execution_end", toolCallId: "failed", content: "已有错误", isError: true } });
    state = {
      ...state,
      items: [...state.items, { kind: "tool", id: "other-run-tool", runId: "run-other", toolCallId: "running", name: "other", argsText: "", output: "other output", status: "running" }],
    };

    const exited = reduceDesk(state, { type: "host", status: { phase: "exited" } });
    expect(exited.phase).toBe("error");
    expect(exited.items.find((item) => item.kind === "assistant" && item.runId === "run-active")).toMatchObject({ text: "部分回答", streaming: false });
    expect(exited.items.find((item) => item.kind === "tool" && item.toolCallId === "running" && item.runId === "run-active")).toMatchObject({ status: "unknown", output: expect.stringContaining("已读到一部分\n执行结果未知") });
    expect(exited.items.find((item) => item.kind === "tool" && item.toolCallId === "done" && item.runId === "run-active")).toMatchObject({ status: "done", output: "完成的输出" });
    expect(exited.items.find((item) => item.kind === "tool" && item.toolCallId === "failed" && item.runId === "run-active")).toMatchObject({ status: "error", output: "已有错误" });
    expect(exited.items.find((item) => item.id === "other-run-tool")).toMatchObject({ status: "running", output: "other output" });
    expect(exited.notice).toContain("结果未知");
    expect(reduceDesk(exited, { type: "agent", runId: "run-active", sequence: 8, event: { type: "tool_execution_end", toolCallId: "running", content: "迟到的结果" } })).toBe(exited);
    expect(reduceDesk(exited, { type: "run-error", runId: "run-other", message: "旧运行错误" })).toBe(exited);

    const failed = reduceDesk(state, { type: "host", status: { phase: "failed", message: "Host failed" } });
    expect(failed.items.find((item) => item.kind === "tool" && item.toolCallId === "running" && item.runId === "run-active")).toMatchObject({ status: "unknown", output: expect.stringContaining("执行结果未知") });
  });

  it("marks unfinished tools unknown on a current run error and keeps their partial output", () => {
    let state = reduceDesk({ ...initialDeskState, host: { phase: "ready" } }, { type: "submit", text: "检查项目" });
    state = reduceDesk(state, { type: "started", runId: "run-error" });
    state = reduceDesk(state, { type: "agent", runId: "run-error", sequence: 1, event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file" } });
    state = reduceDesk(state, { type: "agent", runId: "run-error", sequence: 2, event: { type: "tool_execution_update", toolCallId: "call-1", content: "部分输出" } });

    const errored = reduceDesk(state, { type: "run-error", runId: "run-error", message: "Provider failed" });
    expect(errored.phase).toBe("error");
    expect(errored.items.find((item) => item.kind === "tool")).toMatchObject({ status: "unknown", output: expect.stringContaining("部分输出\n执行结果未知") });
    expect(errored.notice).toBe("Provider failed");
  });

  it.each([
    ["cancelled run-error", { type: "run-error", runId: "run-terminal", message: "cancelled", cancelled: true } as const, "stopped"],
    ["generic failure", { type: "fail", message: "start failed" } as const, "error"],
    ["agent error end", { type: "agent", runId: "run-terminal", sequence: 4, event: { type: "agent_end", status: "error", error: "agent failed" } } as const, "error"],
  ] as const)("settles unfinished tools on the %s path", (_name, action, phase) => {
    let state = reduceDesk({ ...initialDeskState, host: { phase: "ready" } }, { type: "submit", text: "检查项目" });
    state = reduceDesk(state, { type: "started", runId: "run-terminal" });
    state = reduceDesk(state, { type: "agent", runId: "run-terminal", sequence: 1, event: { type: "message_update", turn: 1, delta: "部分回答" } });
    state = reduceDesk(state, { type: "agent", runId: "run-terminal", sequence: 2, event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file" } });
    state = reduceDesk(state, { type: "agent", runId: "run-terminal", sequence: 3, event: { type: "tool_execution_update", toolCallId: "call-1", content: "部分输出" } });

    const terminal = reduceDesk(state, action as DeskAction);
    expect(terminal.phase).toBe(phase);
    expect(terminal.items.find((item) => item.kind === "tool" && item.runId === "run-terminal")).toMatchObject({
      status: "unknown",
      output: expect.stringContaining("部分输出\n执行结果未知"),
    });
    expect(terminal.items.find((item) => item.kind === "assistant" && item.runId === "run-terminal")).toMatchObject({ text: "部分回答", streaming: false });
  });

  it("keeps the normal cancellation notice when no tool is unfinished", () => {
    const cancelled = reduceDesk({ ...initialDeskState, phase: "running", runId: "run-empty" }, { type: "cancelled" });
    expect(cancelled.notice).toBe("运行已停止。");
  });

  it("keeps tool cards from separate runs when the provider reuses a tool call id", () => {
    let state = reduceDesk(initialDeskState, { type: "submit", text: "first" });
    state = reduceDesk(state, { type: "started", runId: "run-1" });
    state = reduceDesk(state, { type: "agent", runId: "run-1", sequence: 1, event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file" } });
    state = reduceDesk(state, { type: "agent", runId: "run-1", sequence: 2, event: { type: "tool_execution_end", toolCallId: "call-1", content: "first result" } });
    state = reduceDesk(state, { type: "agent", runId: "run-1", sequence: 3, event: { type: "agent_end", status: "completed" } });
    state = reduceDesk(state, { type: "submit", text: "second" });
    state = reduceDesk(state, { type: "started", runId: "run-2" });
    state = reduceDesk(state, { type: "agent", runId: "run-2", sequence: 4, event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_file" } });
    state = reduceDesk(state, { type: "agent", runId: "run-2", sequence: 5, event: { type: "tool_execution_end", toolCallId: "call-1", content: "second result" } });
    expect(state.items.filter((item) => item.kind === "tool")).toMatchObject([
      { runId: "run-1", toolCallId: "call-1", output: "first result" },
      { runId: "run-2", toolCallId: "call-1", output: "second result" },
    ]);
  });

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
