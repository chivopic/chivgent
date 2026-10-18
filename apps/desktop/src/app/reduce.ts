import type { AgentEventPayload, HostStatus } from "../protocol/messages.js";

export type RunPhase = "idle" | "running" | "completed" | "stopped" | "error";

export interface UserItem {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly runId: string;
  readonly turn: number;
  readonly text: string;
  readonly streaming: boolean;
}

export interface ToolItem {
  readonly kind: "tool";
  readonly id: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly argsText: string;
  readonly output: string;
  readonly status: "running" | "done" | "error";
}

export type TimelineItem = UserItem | AssistantItem | ToolItem;

export interface DeskState {
  readonly host: HostStatus;
  readonly phase: RunPhase;
  readonly runId: string | null;
  readonly notice: string | null;
  readonly items: readonly TimelineItem[];
  readonly lastSequence: number;
  readonly sequenceGap: boolean;
}

export type DeskAction =
  | { readonly type: "host"; readonly status: HostStatus }
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "started"; readonly runId: string }
  | { readonly type: "agent"; readonly runId: string; readonly sequence: number; readonly event: AgentEventPayload }
  | { readonly type: "run-error"; readonly runId: string; readonly message: string; readonly cancelled?: boolean }
  | { readonly type: "fail"; readonly message: string }
  | { readonly type: "cancelled" }
  | { readonly type: "reset" };

export const initialDeskState: DeskState = {
  host: { phase: "starting", message: "正在连接 Agent host。" },
  phase: "idle",
  runId: null,
  notice: null,
  items: [],
  lastSequence: 0,
  sequenceGap: false,
};

export function reduceDesk(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case "host":
      return applyHost(state, action.status);
    case "reset":
      return { ...initialDeskState, host: state.host };
    case "submit":
      return {
        ...state,
        phase: "running",
        runId: null,
        notice: null,
        items: [...state.items, { kind: "user", id: `user-${state.items.length}`, text: action.text }],
      };
    case "started":
      // An asynchronous ACK must not resurrect an already completed run.
      if (state.phase !== "running" || (state.runId !== null && state.runId !== action.runId)) return state;
      return { ...state, runId: action.runId, notice: null };
    case "run-error":
      if (state.phase !== "running" || state.runId !== action.runId) return state;
      return action.cancelled
        ? { ...state, items: settleStreaming(state.items), phase: "stopped", runId: null, notice: "运行已停止。" }
        : { ...state, items: settleStreaming(state.items), phase: "error", notice: action.message };
    case "fail":
      return { ...state, items: settleStreaming(state.items), phase: "error", notice: action.message };
    case "cancelled":
      return { ...state, items: settleStreaming(state.items), phase: "stopped", runId: null, notice: "运行已停止。" };
    case "agent":
      return applyEvent(state, action.runId, action.sequence, action.event);
  }
}

export function phaseLabel(phase: RunPhase, host: HostStatus): string {
  if (host.phase === "failed" || host.phase === "exited") {
    return host.phase === "failed" ? "Host 启动失败" : "Host 已退出";
  }
  if (host.phase === "starting") {
    return "正在连接";
  }
  switch (phase) {
    case "idle":
      return "就绪";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "stopped":
      return "已停止";
    case "error":
      return "出错";
  }
}

function applyHost(state: DeskState, status: HostStatus): DeskState {
  if (status.phase === "exited" && state.phase === "running") {
    return {
      ...state,
      host: status,
      phase: "error",
      items: settleStreaming(state.items),
      notice: status.message ?? "Agent host 已退出。进行中的运行结果未知。",
    };
  }
  if (status.phase === "failed") {
    return {
      ...state,
      host: status,
      phase: state.phase === "running" ? "error" : state.phase,
      notice: status.message ?? "Agent host 启动失败。",
    };
  }
  return { ...state, host: status };
}

function applyEvent(
  state: DeskState,
  runId: string,
  sequence: number,
  event: AgentEventPayload,
): DeskState {
  // Only the active run may modify the visible timeline or terminal status.
  if (state.phase !== "running" || state.runId !== runId) return state;
  const gap = state.lastSequence !== 0 && sequence !== state.lastSequence + 1;
  const next: DeskState = {
    ...state,
    lastSequence: Math.max(state.lastSequence, sequence),
    sequenceGap: state.sequenceGap || gap,
    notice: gap
      ? "事件序列不连续，时间线可能不完整。"
      : state.notice,
  };
  switch (event.type) {
    case "message_update":
      return appendDelta(next, runId, event.turn ?? 0, event.delta ?? "");
    case "message_end":
      return settleAssistant(next, runId, event.turn ?? 0, event.message?.content ?? "");
    case "tool_execution_start":
      return upsertTool(next, {
        kind: "tool",
        id: event.toolCallId ?? `tool-${next.items.length}`,
        runId,
        toolCallId: event.toolCallId ?? "",
        name: event.toolName ?? "tool",
        argsText: formatArgs(event.arguments),
        output: "",
        status: "running",
      });
    case "tool_execution_update":
      return patchTool(next, event.toolCallId, { output: event.content ?? "" });
    case "tool_execution_end":
      return patchTool(next, event.toolCallId, {
        output: event.content ?? "",
        status: event.isError === true ? "error" : "done",
      });
    case "agent_end":
      return {
        ...next,
        phase: phaseFromAgent(event.status),
        items: settleStreaming(next.items, runId),
        notice: event.status === "error"
          ? event.error ?? "运行失败。"
          : next.notice,
      };
    default:
      return next;
  }
}

function settleStreaming(items: readonly TimelineItem[], runId?: string): readonly TimelineItem[] {
  return items.map((item) =>
    item.kind === "assistant" && item.streaming && (runId === undefined || item.runId === runId)
      ? { ...item, streaming: false }
      : item,
  );
}

function appendDelta(state: DeskState, runId: string, turn: number, delta: string): DeskState {
  const index = findAssistant(state.items, runId, turn);
  if (index === -1) {
    return {
      ...state,
      items: [
        ...state.items,
        { kind: "assistant", id: `assistant-${runId}-${turn}`, runId, turn, text: delta, streaming: true },
      ],
    };
  }
  const current = state.items[index];
  if (current === undefined || current.kind !== "assistant") {
    return state;
  }
  const items = state.items.slice();
  items[index] = { ...current, text: current.text + delta, streaming: true };
  return { ...state, items };
}

function settleAssistant(state: DeskState, runId: string, turn: number, text: string): DeskState {
  const index = findAssistant(state.items, runId, turn);
  if (index === -1) {
    return {
      ...state,
      items: [
        ...state.items,
        { kind: "assistant", id: `assistant-${runId}-${turn}`, runId, turn, text, streaming: false },
      ],
    };
  }
  const current = state.items[index];
  if (current === undefined || current.kind !== "assistant") {
    return state;
  }
  const items = state.items.slice();
  items[index] = { ...current, text, streaming: false };
  return { ...state, items };
}

function upsertTool(state: DeskState, tool: ToolItem): DeskState {
  const index = state.items.findIndex(
    (item) => item.kind === "tool" && item.toolCallId === tool.toolCallId,
  );
  if (index === -1) {
    return { ...state, items: [...state.items, tool] };
  }
  const items = state.items.slice();
  items[index] = tool;
  return { ...state, items };
}

function patchTool(
  state: DeskState,
  toolCallId: string | undefined,
  patch: Partial<Pick<ToolItem, "output" | "status">>,
): DeskState {
  if (toolCallId === undefined) {
    return state;
  }
  const index = state.items.findIndex(
    (item) => item.kind === "tool" && item.toolCallId === toolCallId,
  );
  const current = index === -1 ? undefined : state.items[index];
  if (current === undefined || current.kind !== "tool") {
    return state;
  }
  const items = state.items.slice();
  items[index] = { ...current, ...patch };
  return { ...state, items };
}

function findAssistant(items: readonly TimelineItem[], runId: string, turn: number): number {
  return items.findIndex(
    (item) => item.kind === "assistant" && item.runId === runId && item.turn === turn,
  );
}

function phaseFromAgent(status: string | undefined): RunPhase {
  switch (status) {
    case "completed":
      return "completed";
    case "aborted":
      return "stopped";
    case "error":
    case "max_turns":
      return "error";
    default:
      return "error";
  }
}

function formatArgs(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
