/**
 * Minimal desktop host protocol. This is a closed message set, not a generic
 * RPC framework: initialize, start, event, interrupt, and shutdown.
 *
 * Every value here is structured-cloneable and free of Node or Electron
 * imports so the sandboxed renderer can share it with the host.
 */

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export const HOST_CAPABILITIES = ["project-select", "start", "interrupt", "workspace-review"] as const;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const MAX_PROMPT_LENGTH = 32_000;
export const MAX_MODEL_LENGTH = 160;
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
  readonly provider?: string;
  readonly model?: string;
  readonly permissionMode?: "read-only" | "ask-first" | "workspace";
}

export interface ApprovalRespondRequest {
  readonly type: "approval-respond";
  readonly requestId: string;
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface SelectProjectRequest {
  readonly type: "select-project";
  readonly requestId: string;
  readonly path: string;
}

export interface SaveProviderProfileRequest {
  readonly type: "save-provider-profile";
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

export interface InterruptRequest {
  readonly type: "interrupt";
  readonly requestId: string;
  readonly runId: string;
}

export interface WorkspaceReviewRequest {
  readonly type: "workspace-review";
  readonly requestId: string;
  readonly projectPath: string;
}

export interface ShutdownRequest {
  readonly type: "shutdown";
  readonly requestId: string;
}

export type MainToHost =
  | InitializeRequest
  | SelectProjectRequest
  | SaveProviderProfileRequest
  | StartRequest
  | InterruptRequest
  | ApprovalRespondRequest
  | WorkspaceReviewRequest
  | ShutdownRequest;

export interface InitializedMessage {
  readonly type: "initialized";
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly hostInstanceId: string;
  readonly capabilities: readonly string[];
  readonly defaultProvider: string;
  readonly compatibleBaseURL?: string;
  readonly providerProfiles?: readonly { readonly provider: string; readonly model: string; readonly baseURL?: string; readonly configured: true }[];
  readonly providerConfigNotice?: string;
  readonly snapshot?: SessionSnapshot;
  readonly historyNotice?: string;
}

export interface SessionSnapshot {
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly projectPath: string;
  readonly sequence: number;
  readonly events: readonly { readonly sequence: number; readonly runId: string; readonly event: AgentEventPayload }[];
  readonly run?: { readonly runId: string; readonly status: "started" | "running" | "completed" | "interrupted" | "unknown"; readonly prompt: string };
  readonly runs?: readonly { readonly runId: string; readonly status: "started" | "running" | "completed" | "interrupted" | "unknown"; readonly prompt: string }[];
  readonly pendingApprovals?: readonly ApprovalMessage[];
  readonly incomplete: boolean;
  readonly corruption: "tail" | "middle" | null;
}

export interface StartedMessage {
  readonly type: "started";
  readonly requestId: string;
  readonly runId: string;
  /** True when this requestId was already accepted and the original run is returned. */
  readonly replayed: boolean;
}

export interface ProjectSelectedMessage {
  readonly type: "project-selected";
  readonly requestId: string;
  readonly path: string;
}
export interface ProviderProfileSavedMessage {
  readonly type: "provider-profile-saved";
  readonly requestId: string;
  readonly profile: { readonly provider: string; readonly model: string; readonly baseURL?: string; readonly configured: true; readonly recovered?: true };
}
export interface WorkspaceReviewMessage {
  readonly type: "workspace-review";
  readonly requestId: string;
  readonly projectPath: string;
  readonly review: WorkspaceReviewData;
}
export type WorkspaceReviewFile = { readonly path: string; readonly kind: "text"; readonly content: string } | { readonly path: string; readonly kind: "binary" | "too-large" | "unsafe" | "unavailable" };
export type WorkspaceReviewData = { readonly kind: "not-git" } | { readonly kind: "git"; readonly staged: string; readonly unstaged: string; readonly untracked: readonly WorkspaceReviewFile[]; readonly truncated: boolean };
export interface RuntimeConfigMessage {
  readonly type: "runtime-config";
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
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

export interface ApprovalMessage {
  readonly type: "approval";
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly action: string;
  readonly context: string;
}

export interface ApprovalRespondedMessage {
  readonly type: "approval-responded";
  readonly requestId: string;
  readonly accepted: boolean;
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
  readonly hostInstanceId?: string;
  readonly sessionId?: string;
  readonly runId: string;
  readonly sequence: number;
  readonly event: AgentEventPayload;
}

export type HostToMain =
  | InitializedMessage
  | ProjectSelectedMessage
  | ProviderProfileSavedMessage
  | WorkspaceReviewMessage
  | RuntimeConfigMessage
  | StartedMessage
  | InterruptedMessage
  | ShutdownAckMessage
  | ApprovalMessage
  | ApprovalRespondedMessage
  | HostErrorMessage
  | DesktopEventMessage;

/**
 * The subset of the kernel AgentEvent the desktop timeline renders. The host
 * forwards the real event object; unknown fields are preserved and ignored.
 */
export interface AgentEventPayload {
  readonly type: string;
  readonly approvalId?: string;
  readonly action?: string;
  readonly context?: string;
  readonly approved?: boolean;
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
    case "select-project":
      if (typeof record.path !== "string" || record.path.length === 0 || record.path.length > 4_096) {
        return "path must be a non-empty directory path.";
      }
      return { type: "select-project", requestId: record.requestId, path: record.path };
    case "save-provider-profile":
      if (typeof record.provider !== "string" || !/^[a-z0-9-]{1,80}$/.test(record.provider)) return "provider is invalid.";
      if (typeof record.model !== "string" || record.model.trim().length === 0 || record.model.length > MAX_MODEL_LENGTH) return `model must be 1-${MAX_MODEL_LENGTH} non-empty characters.`;
      if (record.apiKey !== undefined && (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0 || record.apiKey.length > 4_096)) return "apiKey must be a non-empty string when provided.";
      if (record.baseURL !== undefined && (typeof record.baseURL !== "string" || record.baseURL.length > 2_048)) return "baseURL is invalid.";
      return { type: "save-provider-profile", requestId: record.requestId, provider: record.provider, model: record.model.trim(), ...(record.apiKey === undefined ? {} : { apiKey: record.apiKey as string }), ...(record.baseURL === undefined ? {} : { baseURL: record.baseURL as string }) };
    case "start":
      if (typeof record.prompt !== "string" || record.prompt.trim().length === 0) {
        return "prompt must be a non-empty string.";
      }
      if (record.prompt.length > MAX_PROMPT_LENGTH) {
        return `prompt exceeds ${MAX_PROMPT_LENGTH} characters.`;
      }
      if (record.provider !== undefined && (typeof record.provider !== "string" || !/^[a-z0-9-]{1,80}$/.test(record.provider))) return "provider is invalid.";
      if (record.model !== undefined && (typeof record.model !== "string" || record.model.trim().length === 0 || record.model.length > MAX_MODEL_LENGTH)) return `model must be 1-${MAX_MODEL_LENGTH} non-empty characters.`;
      if (record.permissionMode !== undefined && !["read-only", "ask-first", "workspace"].includes(String(record.permissionMode))) return "permissionMode is invalid.";
      return {
        type: "start",
        requestId: record.requestId,
        prompt: record.prompt,
        ...(record.provider === undefined ? {} : { provider: record.provider as string }),
        ...(record.model === undefined ? {} : { model: (record.model as string).trim() }),
        ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode as StartRequest["permissionMode"] }),
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
    case "approval-respond":
      if (!isRequestId(record.hostInstanceId) || !isRequestId(record.sessionId) || !isRequestId(record.runId) || !isRequestId(record.approvalId) || typeof record.approved !== "boolean") return "approval response correlation or decision is invalid.";
      return { type: "approval-respond", requestId: record.requestId, hostInstanceId: record.hostInstanceId, sessionId: record.sessionId, runId: record.runId, approvalId: record.approvalId, approved: record.approved };
    case "workspace-review":
      if (typeof record.projectPath !== "string" || record.projectPath.length === 0 || record.projectPath.length > 4_096) return "projectPath must be a non-empty directory path.";
      return { type: "workspace-review", requestId: record.requestId, projectPath: record.projectPath };
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
        Array.isArray(record.capabilities) &&
        record.capabilities.every((capability) => typeof capability === "string") &&
        typeof record.defaultProvider === "string" &&
        (record.compatibleBaseURL === undefined || typeof record.compatibleBaseURL === "string") &&
        (record.providerProfiles === undefined || (Array.isArray(record.providerProfiles) && record.providerProfiles.every((profile) => typeof profile === "object" && profile !== null && typeof profile.provider === "string" && typeof profile.model === "string" && profile.configured === true && !("apiKey" in profile)))) &&
        (record.providerConfigNotice === undefined || typeof record.providerConfigNotice === "string") &&
        (record.historyNotice === undefined || typeof record.historyNotice === "string") &&
        (record.snapshot === undefined || isSessionSnapshot(record.snapshot))
      );
    case "project-selected":
      return isRequestId(record.requestId) && typeof record.path === "string" && record.path.length > 0;
    case "provider-profile-saved": {
      const profile = record.profile as Record<string, unknown> | null;
      return isRequestId(record.requestId) && typeof profile === "object" && profile !== null && typeof profile.provider === "string" && typeof profile.model === "string" && profile.configured === true && (profile.recovered === undefined || profile.recovered === true) && !("apiKey" in profile);
    }
    case "workspace-review":
      return isRequestId(record.requestId) && typeof record.projectPath === "string" && isWorkspaceReview(record.review);
    case "runtime-config":
      return typeof record.provider === "string" && record.provider.length > 0 && typeof record.model === "string" && record.model.length > 0 && (record.baseURL === undefined || typeof record.baseURL === "string");
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
    case "approval-responded":
      return isRequestId(record.requestId) && typeof record.accepted === "boolean";
    case "approval":
      return isRequestId(record.hostInstanceId) && isRequestId(record.sessionId) && isRequestId(record.runId) && isRequestId(record.approvalId) && typeof record.action === "string" && typeof record.context === "string";
    case "error":
      return typeof record.code === "string" && typeof record.message === "string";
    case "event":
      return (
        isRequestId(record.hostInstanceId) &&
        isRequestId(record.sessionId) &&
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

function isWorkspaceReview(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "not-git") return true;
  if (item.kind !== "git" || typeof item.staged !== "string" || typeof item.unstaged !== "string" || typeof item.truncated !== "boolean" || !Array.isArray(item.untracked)) return false;
  return item.untracked.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string" && ["text", "binary", "too-large", "unsafe", "unavailable"].includes(String((entry as { kind?: unknown }).kind)) && ((entry as { kind?: unknown }).kind !== "text" || typeof (entry as { content?: unknown }).content === "string"));
}

export function acceptedRequestLimit(): number {
  return MAX_ACCEPTED_REQUESTS;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const validRun = (run: unknown): boolean => typeof run === "object" && run !== null && isRequestId((run as { runId?: unknown }).runId) &&
    typeof (run as { prompt?: unknown }).prompt === "string" && ["started", "running", "completed", "interrupted", "unknown"].includes(String((run as { status?: unknown }).status));
  return isRequestId(item.hostInstanceId) && isRequestId(item.sessionId) && typeof item.projectPath === "string" &&
    Number.isSafeInteger(item.sequence) && (item.sequence as number) >= 0 && Array.isArray(item.events) && item.events.every((event) => typeof event === "object" && event !== null &&
      Number.isSafeInteger((event as { sequence?: unknown }).sequence) && ((event as { sequence: number }).sequence > 0) && isRequestId((event as { runId?: unknown }).runId) &&
      typeof (event as { event?: unknown }).event === "object" && (event as { event?: { type?: unknown } }).event !== null && typeof (event as { event: { type?: unknown } }).event.type === "string") &&
    (item.run === undefined || validRun(item.run)) && (item.runs === undefined || (Array.isArray(item.runs) && item.runs.every(validRun))) &&
    (item.pendingApprovals === undefined || (Array.isArray(item.pendingApprovals) && item.pendingApprovals.every((approval) => isHostToMain(approval) && approval.type === "approval"))) &&
    typeof item.incomplete === "boolean" && (item.corruption === null || item.corruption === "tail" || item.corruption === "middle");
}
