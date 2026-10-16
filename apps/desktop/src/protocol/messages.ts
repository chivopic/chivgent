/**
 * Minimal desktop host protocol. This is a closed message set, not a generic
 * RPC framework: initialize, start, event, interrupt, and shutdown.
 *
 * Every value here is structured-cloneable and free of Node or Electron
 * imports so the sandboxed renderer can share it with the host.
 */

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export const HOST_CAPABILITIES = ["stub-agent", "start", "interrupt"] as const;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_ACCEPTED_REQUESTS = 100;

export type HostPhase = "starting" | "ready" | "failed" | "exited";

export interface HostStatus {
  readonly phase: HostPhase;
  readonly message?: string;
  readonly hostInstanceId?: string;
  readonly exitCode?: number | null;
}

export interface InitializeRequest {
  readonly type: "initialize";
  readonly requestId: string;
}

export interface StartRequest {
  readonly type: "start";
  readonly requestId: string;
  readonly prompt: string;
}

export interface InterruptRequest {
  readonly type: "interrupt";
  readonly requestId: string;
  readonly runId: string;
}

export interface ShutdownRequest {
  readonly type: "shutdown";
  readonly requestId: string;
}

export type MainToHost =
  | InitializeRequest
  | StartRequest
  | InterruptRequest
  | ShutdownRequest;

export interface InitializedMessage {
  readonly type: "initialized";
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly capabilities: readonly string[];
}

export interface StartedMessage {
  readonly type: "started";
  readonly requestId: string;
  readonly runId: string;
  /** True when this requestId was already accepted and the original run is returned. */
  readonly replayed: boolean;
}

export interface InterruptedMessage {
  readonly type: "interrupted";
  readonly requestId: string;
  readonly runId: string;
  readonly accepted: boolean;
}

export interface ShutdownAckMessage {
  readonly type: "shutdown_ack";
  readonly requestId: string;
}

export interface HostErrorMessage {
  readonly type: "error";
  readonly requestId?: string;
  readonly runId?: string;
  readonly code: string;
  readonly message: string;
}

/**
 * One Agent event, correlated to a run. `sequence` is monotonic per host
 * instance. A gap means the renderer must not invent the missing events.
 */
export interface DesktopEventMessage {
  readonly type: "event";
  readonly runId: string;
  readonly sequence: number;
  readonly event: AgentEventPayload;
}

export type HostToMain =
  | InitializedMessage
  | StartedMessage
  | InterruptedMessage
  | ShutdownAckMessage
  | HostErrorMessage
  | DesktopEventMessage;

/**
 * The subset of the kernel AgentEvent the desktop timeline renders. The host
 * forwards the real event object; unknown fields are preserved and ignored.
 */
export interface AgentEventPayload {
  readonly type: string;
  readonly turn?: number;
  readonly delta?: string;
  readonly prompt?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly arguments?: unknown;
  readonly content?: string;
  readonly isError?: boolean;
  readonly status?: string;
  readonly error?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
  };
}

export type IpcSuccess<T> = { readonly ok: true; readonly value: T };
export type IpcFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
};
export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly capabilities: readonly string[];
}

export interface StartResult {
  readonly runId: string;
  readonly replayed: boolean;
}

export interface InterruptResult {
  readonly runId: string;
  readonly accepted: boolean;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export function validateMainToHost(value: unknown): MainToHost | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Host request must be an object.";
  }
  const record = value as Record<string, unknown>;
  if (!isRequestId(record.requestId)) {
    return "requestId must be 1-80 characters of letters, digits, _ or -.";
  }
  switch (record.type) {
    case "initialize":
    case "shutdown":
      return { type: record.type, requestId: record.requestId };
    case "start":
      if (typeof record.prompt !== "string" || record.prompt.trim().length === 0) {
        return "prompt must be a non-empty string.";
      }
      if (record.prompt.length > MAX_PROMPT_LENGTH) {
        return `prompt exceeds ${MAX_PROMPT_LENGTH} characters.`;
      }
      return {
        type: "start",
        requestId: record.requestId,
        prompt: record.prompt,
      };
    case "interrupt":
      if (!isRequestId(record.runId)) {
        return "runId must be 1-80 characters of letters, digits, _ or -.";
      }
      return {
        type: "interrupt",
        requestId: record.requestId,
        runId: record.runId,
      };
    default:
      return "Unknown host request type.";
  }
}

export function isHostToMain(value: unknown): value is HostToMain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "initialized":
      return (
        isRequestId(record.requestId) &&
        record.protocolVersion === DESKTOP_PROTOCOL_VERSION &&
        isRequestId(record.hostInstanceId) &&
        Array.isArray(record.capabilities)
      );
    case "started":
      return (
        isRequestId(record.requestId) &&
        isRequestId(record.runId) &&
        typeof record.replayed === "boolean"
      );
    case "interrupted":
      return (
        isRequestId(record.requestId) &&
        isRequestId(record.runId) &&
        typeof record.accepted === "boolean"
      );
    case "shutdown_ack":
      return isRequestId(record.requestId);
    case "error":
      return typeof record.code === "string" && typeof record.message === "string";
    case "event":
      return (
        isRequestId(record.runId) &&
        typeof record.sequence === "number" &&
        Number.isSafeInteger(record.sequence) &&
        record.sequence > 0 &&
        typeof record.event === "object" &&
        record.event !== null &&
        typeof (record.event as { type?: unknown }).type === "string"
      );
    default:
      return false;
  }
}

export function acceptedRequestLimit(): number {
  return MAX_ACCEPTED_REQUESTS;
}
