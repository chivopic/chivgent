import type { AgentEvent } from "../events.js";
import type { Message } from "../messages.js";

/**
 * Bumped whenever the shape below changes in a way an older peer would
 * misread. A mismatch is refused with both versions named, which costs one
 * release note and saves a baffling debugging session later.
 */
export const PROTOCOL_VERSION = 1;

export type ProtocolErrorCode =
  | "version_mismatch"
  | "busy"
  | "bad_message"
  | "too_large"
  | "agent_error";

export interface SessionSummary {
  readonly id: string;
  readonly cwd: string;
  readonly turns: number;
  readonly messages: number;
  /** Capabilities the server was started with, so an attaching client can see them. */
  readonly capabilities: readonly string[];
}

export interface ClientHello {
  readonly type: "hello";
  readonly version: number;
}

export interface ClientPrompt {
  readonly type: "prompt";
  readonly text: string;
}

export interface ClientInterrupt {
  readonly type: "interrupt";
}

export type ClientMessage = ClientHello | ClientPrompt | ClientInterrupt;

export interface ServerHello {
  readonly type: "hello";
  readonly version: number;
  readonly session: SessionSummary;
  readonly tools: readonly string[];
}

export interface ServerError {
  readonly type: "error";
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

/**
 * An AgentEvent, wrapped rather than sent bare.
 *
 * Without the wrapper the protocol's own messages share a namespace with the
 * agent's events, and the day an event type called "error" is added the two
 * collide silently.
 */
export interface ServerEvent {
  readonly type: "event";
  readonly event: AgentEvent;
}

export interface ServerBye {
  readonly type: "bye";
  readonly reason: string;
}

/** Sent when a run finishes, so a one-shot client knows when to leave. */
export interface ServerResult {
  readonly type: "result";
  readonly status: "completed" | "max_turns" | "aborted" | "error";
  readonly messages: number;
}

export type ServerMessage =
  | ServerHello
  | ServerError
  | ServerEvent
  | ServerBye
  | ServerResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one client message, or returns why it is not one. */
export function parseClientMessage(
  value: unknown,
): { readonly message: ClientMessage } | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "A message must be a JSON object." };
  }
  switch (value.type) {
    case "hello":
      if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
        return { error: "hello needs an integer version." };
      }
      return { message: { type: "hello", version: value.version } };
    case "prompt":
      if (typeof value.text !== "string" || value.text.trim().length === 0) {
        return { error: "prompt needs a non-empty text." };
      }
      return { message: { type: "prompt", text: value.text } };
    case "interrupt":
      return { message: { type: "interrupt" } };
    default:
      return { error: `Unknown message type: ${String(value.type)}` };
  }
}

export function parseServerMessage(
  value: unknown,
): { readonly message: ServerMessage } | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "A message must be a JSON object." };
  }
  switch (value.type) {
    case "hello":
      if (
        typeof value.version !== "number" ||
        !isRecord(value.session) ||
        !Array.isArray(value.tools)
      ) {
        return { error: "hello is missing version, session or tools." };
      }
      return { message: value as unknown as ServerHello };
    case "error":
      if (typeof value.message !== "string" || typeof value.code !== "string") {
        return { error: "error needs a code and a message." };
      }
      return { message: value as unknown as ServerError };
    case "event":
      if (!isRecord(value.event) || typeof value.event.type !== "string") {
        return { error: "event needs an event object." };
      }
      return { message: value as unknown as ServerEvent };
    case "result":
      if (typeof value.status !== "string") {
        return { error: "result needs a status." };
      }
      return { message: value as unknown as ServerResult };
    case "bye":
      return {
        message: {
          type: "bye",
          reason: typeof value.reason === "string" ? value.reason : "",
        },
      };
    default:
      return { error: `Unknown message type: ${String(value.type)}` };
  }
}

export function summariseSession(options: {
  readonly id: string;
  readonly cwd: string;
  readonly turns: number;
  readonly messages: readonly Message[];
  readonly capabilities: readonly string[];
}): SessionSummary {
  return {
    id: options.id,
    cwd: options.cwd,
    turns: options.turns,
    messages: options.messages.length,
    capabilities: options.capabilities,
  };
}
