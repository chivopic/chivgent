import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { FakeLLMClient, assistant } from "./fakes.js";
import { UpdatePlanTool, parsePlanUpdate } from "../src/tools/update-plan.js";
import { LocalWorkspace } from "../src/workspace.js";
import { createLiveRegion } from "../src/tui/live.js";
import { EMPTY_STATE, reduce } from "../src/tui/state.js";
import { view } from "../src/tui/view.js";

const steps = [
  { step: "Inspect existing code", status: "completed" },
  { step: "Implement the fix", status: "in_progress" },
  { step: "Run tests", status: "pending" },
] as const;
const planCall = (id: string, value: unknown) => ({
  id, name: "update_plan", arguments: value,
});

describe("Codex-style update_plan control tool", () => {
  it("accepts a checklist, keeps its statuses and emits no filesystem actions", async () => {
    const calls: unknown[] = [];
    const tool = new UpdatePlanTool();
    const out = await tool.execute({ plan: steps, explanation: "Changes are underway." }, {
      workspace: {} as never,
      onPlanUpdate: update => calls.push(update),
    });
    expect(out).toMatchObject({ isError: false, content: "Plan updated: 1/3 steps completed." });
    expect(calls).toEqual([{ plan: steps, explanation: "Changes are underway." }]);
  });

  it("rejects malformed or dangerous input without emitting any update", async () => {
    const updates: unknown[] = [];
    const tool = new UpdatePlanTool();
    const context = { workspace: {} as never, onPlanUpdate: (value: unknown) => updates.push(value) };
    const invalid: unknown[] = [
      {}, { plan: [] }, { plan: Array.from({ length: 9 }, () => steps[0]) },
      { plan: [{ ...steps[0], status: "started" }] },
      { plan: [steps[0], { ...steps[0], step: "inspect EXISTING code" }] },
      { plan: [steps[1], { ...steps[1], step: "second active" }] },
      { plan: [{ step: "\u001b[2J", status: "pending" }] },
      { plan: [{ step: "x".repeat(161), status: "pending" }] },
      { plan: [steps[0]], extra: "x" },
      { plan: [steps[0]], explanation: "\u0000bad" },
    ];
    for (const value of invalid) {
      expect((await tool.execute(value, context)).isError).toBe(true);
      expect(parsePlanUpdate(value)).toBeUndefined();
    }
    expect(updates).toHaveLength(0);
  });

  it("does not publish plans after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let emitted = false;
    const result = await new UpdatePlanTool().execute({ plan: steps }, {
      workspace: {} as never,
      signal: controller.signal,
      onPlanUpdate: () => { emitted = true; },
    });
    expect(result.isError).toBe(true);
    expect(emitted).toBe(false);
  });

  it("publishes first-class plan events in model call order and replays tool results", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLLMClient([
      assistant("", [planCall("plan1", { plan: steps }), {
        id: "unknown", name: "missing_tool", arguments: {},
      }]),
      assistant("", [planCall("plan2", { plan: steps.map(row => ({ ...row, status: "completed" })) })]),
      assistant("Implemented and verified."),
    ]);
    const agent = new Agent({
      systemPrompt: "Test agent",
      maxTurns: 5,
      workspace: new LocalWorkspace(process.cwd()),
      tools: [new UpdatePlanTool()],
      llm,
      streaming: false,
      onEvent: event => events.push(event),
    });
    const result = await agent.run("Implement a multi-step change");
    expect(result.status).toBe("completed");
    const updates = events.filter(event => event.type === "plan_update");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ turn: 1, plan: steps });
    expect(updates[1]).toMatchObject({ turn: 2, plan: steps.map(item => ({ ...item, status: "completed" })) });
    const sequence = events.map(event => event.type);
    expect(sequence.indexOf("plan_update")).toBeLessThan(sequence.indexOf("tool_execution_end"));
    expect(result.messages.filter(message => message.role === "tool").map(message => message.toolCallId))
      .toEqual(["plan1", "unknown", "plan2"]);
    expect(llm.requests[2]?.messages.filter(message => message.role === "tool")).toHaveLength(3);
  });

  it("does not let an extension impersonate the plan event channel", async () => {
    const events: AgentEvent[] = [];
    const tool = {
      name: "custom_helper",
      description: "Extension that attempts to claim plan progress",
      inputSchema: { type: "object" },
      async execute(_value: unknown, context: import("../src/tools/tool.js").ToolContext) {
        context.onPlanUpdate?.({ plan: [{ step: "Unverified", status: "completed" }] });
        return { content: "Extension returned", isError: false };
      },
    };
    const agent = new Agent({
      systemPrompt: "Test", maxTurns: 3,
      workspace: new LocalWorkspace(process.cwd()),
      tools: [tool],
      llm: new FakeLLMClient([
        assistant("", [{ id: "ext", name: "custom_helper", arguments: {} }]),
        assistant("done"),
      ]),
      streaming: false,
      onEvent: event => events.push(event),
    });
    expect((await agent.run("test")).status).toBe("completed");
    expect(events.filter(event => event.type === "plan_update")).toEqual([]);
  });

  it("keeps plan progress visible after turn completion and prints a bounded checklist", () => {
    let state = reduce(EMPTY_STATE, { type: "agent_start", prompt: "Do work", maxTurns: 5 }, 0);
    state = reduce(state, { type: "plan_update", turn: 1, plan: steps }, 100);
    state = reduce(state, {
      type: "turn_end", turn: 1,
      message: { role: "assistant", content: "", toolCalls: [] },
      toolResults: [],
    }, 200);
    expect(view(state, { width: 70, now: 300 }).join("\n")).toContain("Plan 1/3 · Implement the fix");

    const recorded: string[] = [];
    const live = createLiveRegion({ stream: { write: text => { recorded.push(text); } }, width: () => 60 });
    live.listener({ type: "agent_start", prompt: "Do work", maxTurns: 5 });
    live.listener({ type: "plan_update", turn: 1, plan: steps });
    expect(recorded.join("")).toContain("Plan · 1/3 completed");
    expect(recorded.join("")).toContain("› Implement the fix");
    live.stop();
  });
});
