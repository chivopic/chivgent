import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "./messages.js";

/**
 * Terminal state of one Agent run. `aborted` is reported, never thrown, so a
 * cancelled run stays as observable as a completed one.
 */
export type AgentRunStatus =
  | "completed"
  | "max_turns"
  | "aborted"
  | "error";

/**
 * Runtime events emitted while the Agent Loop runs. The vocabulary is
 * deliberately close to the JSON event protocols used by larger harnesses so a
 * transcript can be replayed or rendered without inspecting Agent internals.
 *
 * Every event is a plain, structured-cloneable object: renderers, loggers, and
 * a future RPC mode can serialise it directly.
 */
export type AgentEvent =
  | AgentStartEvent
  | TurnStartEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | TurnEndEvent
  | AgentEndEvent;

export interface AgentStartEvent {
  readonly type: "agent_start";
  readonly prompt: string;
  readonly maxTurns: number;
}

export interface TurnStartEvent {
  readonly type: "turn_start";
  readonly turn: number;
}

/** An assistant message is about to be produced for the current turn. */
export interface MessageStartEvent {
  readonly type: "message_start";
  readonly turn: number;
}

/**
 * Incremental assistant text. Deltas carry no cumulative snapshot, so the
 * stream stays linear in the length of the answer.
 */
export interface MessageUpdateEvent {
  readonly type: "message_update";
  readonly turn: number;
  readonly delta: string;
}

/** The authoritative assistant message, after any deltas. */
export interface MessageEndEvent {
  readonly type: "message_end";
  readonly turn: number;
  readonly message: AssistantMessage;
}

export interface ToolExecutionStartEvent {
  readonly type: "tool_execution_start";
  readonly turn: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface ToolExecutionEndEvent {
  readonly type: "tool_execution_end";
  readonly turn: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface TurnEndEvent {
  readonly type: "turn_end";
  readonly turn: number;
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
}

export interface AgentEndEvent {
  readonly type: "agent_end";
  readonly status: AgentRunStatus;
  readonly turnCount: number;
  readonly messages: readonly Message[];
  readonly error?: string;
}

/**
 * Receives events synchronously, in emission order. A listener that throws is
 * isolated: rendering must never corrupt the run that produced the event.
 */
export type AgentEventListener = (event: AgentEvent) => void;

export function emitEvent(
  listener: AgentEventListener | undefined,
  event: AgentEvent,
): void {
  if (listener === undefined) {
    return;
  }
  try {
    listener(structuredClone(event) as AgentEvent);
  } catch {
    // A failing listener must not change the outcome of the run.
  }
}
