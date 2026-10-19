import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import type { Agent } from "@chivgent/agent.ts";
import type { AgentEvent } from "@chivgent/events.ts";
import type { Message } from "@chivgent/messages.ts";
import type { AppliedCompaction } from "@chivgent/context/context-manager.ts";
import { DesktopHistory, HistoryWriteError, readLastProject, saveLastProject, type HistoryEvent, type LoadedHistory } from "./history.js";
import {
  acceptedRequestLimit,
  DESKTOP_PROTOCOL_VERSION,
  HOST_CAPABILITIES,
  validateMainToHost,
  type HostToMain,
  type StartRequest,
} from "../protocol/messages.js";

export interface AcceptedStart {
  readonly requestId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly projectPath?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface HostServiceOptions {
  readonly send: (message: HostToMain) => void;
  readonly createAgent: (onEvent: (event: AgentEvent) => void, projectPath?: string) => Agent;
  readonly defaultProvider?: string;
  readonly compatibleBaseURL?: string;
  readonly createSession?: SessionFactory;
  readonly createId?: () => string;
  readonly historyDirectory?: string;
}

export interface RuntimeSession {
  readonly messages: readonly Message[];
  readonly compactionCheckpoint?: AppliedCompaction;
  prompt(text: string, options: { signal: AbortSignal }): Promise<unknown>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface RuntimeSessionResult {
  readonly session: RuntimeSession;
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
}

export type SessionFactory = (
  cwd: string,
  provider: string | undefined,
  model: string | undefined,
  messages: readonly Message[] | undefined,
  compaction: AppliedCompaction | undefined,
) => Promise<RuntimeSessionResult>;

/**
 * Owns one active run and its current project session. The Agent is the only
 * thing that decides completion; this class correlates requestId, runId, and sequence.
 */
export class HostService {
  readonly instanceId: string;
  private readonly send: (message: HostToMain) => void;
  private readonly createAgent: HostServiceOptions["createAgent"];
  private readonly createSession: HostServiceOptions["createSession"];
  private readonly createId: () => string;
  private readonly defaultProvider: string;
  private readonly compatibleBaseURL: string | undefined;
  private readonly accepted = new Map<string, AcceptedStart>();
  private active: ActiveRun | undefined;
  private sequence = 0;
  private closed = false;
  private projectPath: string | undefined;
  private session: RuntimeSessionResult | undefined;
  private sessionConfigKey: string | undefined;
  private readonly historyDirectory: string | undefined;
  private history: DesktopHistory | undefined;
  private loadedHistory: LoadedHistory | undefined;
  private timelineEvents: HistoryEvent[] = [];
  private historyNotice: string | undefined;

  constructor(options: HostServiceOptions) {
    this.send = options.send;
    this.createAgent = options.createAgent;
    this.createSession = options.createSession;
    this.createId = options.createId ?? (() => randomBytes(8).toString("hex"));
    this.historyDirectory = options.historyDirectory;
    this.defaultProvider = options.defaultProvider || "openai";
    this.compatibleBaseURL = safeEndpoint(options.compatibleBaseURL);
    this.instanceId = `host-${this.createId()}`;
  }

  handle(value: unknown): void {
    if (this.closed) {
      return;
    }
    const request = validateMainToHost(value);
    if (typeof request === "string") {
      const requestId = readRequestId(value);
      this.send({
        type: "error",
        ...(requestId === undefined ? {} : { requestId }),
        code: "bad_request",
        message: request,
      });
      return;
    }
    switch (request.type) {
      case "initialize":
        this.restoreLastProject();
        this.send({
          type: "initialized",
          requestId: request.requestId,
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          hostInstanceId: this.instanceId,
          capabilities: [...HOST_CAPABILITIES, this.createSession === undefined ? "demo-agent" : "real-agent"],
          defaultProvider: this.defaultProvider,
          ...(this.compatibleBaseURL === undefined ? {} : { compatibleBaseURL: this.compatibleBaseURL }),
          ...(this.historyNotice === undefined ? {} : { historyNotice: this.historyNotice }),
          ...(this.snapshot() === undefined ? {} : { snapshot: this.snapshot() }),
        });
        return;
      case "start":
        this.start(request);
        return;
      case "select-project":
        void this.selectProject(request.requestId, request.path);
        return;
      case "interrupt":
        this.interrupt(request.requestId, request.runId);
        return;
      case "shutdown":
        void this.shutdown(request.requestId);
        return;
    }
  }

  async shutdown(requestId = "shutdown"): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (active !== undefined) {
      active.controller.abort();
      await Promise.race([
        active.done,
        wait(1_500),
      ]);
    }
    this.history?.close();
    this.send({ type: "shutdown_ack", requestId });
  }

  private start(request: StartRequest): void {
    const previous = this.accepted.get(request.requestId);
    if (previous !== undefined) {
      if (previous.prompt !== request.prompt || previous.projectPath !== this.projectPath || previous.provider !== request.provider || previous.model !== request.model) {
        this.send({
          type: "error",
          requestId: request.requestId,
          code: "request_conflict",
          message: "This requestId was already accepted with a different prompt.",
        });
        return;
      }
      this.send({
        type: "started",
        requestId: request.requestId,
        runId: previous.runId,
        replayed: true,
      });
      return;
    }
    if (this.accepted.size >= acceptedRequestLimit()) {
      this.send({
        type: "error",
        requestId: request.requestId,
        code: "request_log_full",
        message: "The host cannot accept another start until it restarts.",
      });
      return;
    }
    if (this.active !== undefined) {
      this.send({
        type: "error",
        requestId: request.requestId,
        code: "busy",
        message: "A run is already in progress.",
      });
      return;
    }
    if (this.createSession !== undefined && this.projectPath === undefined) {
      this.send({ type: "error", requestId: request.requestId, code: "project_required", message: "请先选择项目目录。" });
      return;
    }

    const runId = `run-${this.createId()}`;
    const accepted: AcceptedStart = {
      requestId: request.requestId,
      runId,
      prompt: request.prompt,
      ...(this.projectPath === undefined ? {} : { projectPath: this.projectPath }),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
    };
    this.accepted.set(request.requestId, accepted);
    try {
      this.history?.saveRun({ type: "run", runId, prompt: request.prompt, status: "started" });
    } catch (error: unknown) {
      this.accepted.delete(request.requestId);
      this.historyNotice = `历史保存失败，未开始运行：${error instanceof Error ? error.message : "未知错误"}`;
      this.send({ type: "error", requestId: request.requestId, runId, code: "history_write_failed", historyStage: "acceptance", message: this.historyNotice });
      return;
    }
    const controller = new AbortController();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active = { runId, requestId: request.requestId, prompt: request.prompt, controller, done };
    this.send({
      type: "started",
      requestId: request.requestId,
      runId,
      replayed: false,
    });

    const onEvent = (event: AgentEvent): void => {
      this.sequence += 1;
      const stored: HistoryEvent = { type: "event", sequence: this.sequence, runId, event };
      this.timelineEvents.push(stored);
      try {
        // Streaming text stays in host memory for refresh snapshots; terminal and tool state is journaled.
        if (event.type !== "message_update") this.history?.appendEvent(stored);
      } catch (error: unknown) {
        this.historyNotice = `历史保存失败：${error instanceof Error ? error.message : "未知错误"}`;
        this.send({ type: "error", runId, code: "history_write_failed", historyStage: "event", message: this.historyNotice });
      }
      this.send({
        type: "event",
        hostInstanceId: this.instanceId,
        sessionId: this.sessionId(),
        runId,
        sequence: this.sequence,
        event,
      });
    };

    const run = async (): Promise<void> => {
      if (this.createSession !== undefined) {
        const configKey = JSON.stringify([request.provider ?? null, request.model ?? null]);
        if (this.session === undefined || this.sessionConfigKey !== configKey) {
          const messages = this.session?.session.messages ?? this.loadedHistory?.messages;
          const compaction = this.session?.session.compactionCheckpoint ?? this.loadedHistory?.compaction;
          const pendingSession = this.createSession(this.projectPath!, request.provider, request.model, messages, compaction);
          const initialized = await awaitWithAbort(pendingSession, controller.signal);
          if (initialized.aborted) {
            this.send({ type: "error", requestId: request.requestId, runId, code: "cancelled", message: "运行已停止。" });
            return;
          }
          if (this.active?.runId !== runId || controller.signal.aborted || this.closed) return;
          this.session = initialized.value;
          this.sessionConfigKey = configKey;
          const baseURL = safeEndpoint(this.session.baseURL);
          this.send({ type: "runtime-config", provider: this.session.provider, model: this.session.model,
            ...(baseURL === undefined ? {} : { baseURL }) });
        }
        if (controller.signal.aborted) {
          this.send({ type: "error", requestId: request.requestId, runId, code: "cancelled", message: "运行已取消。" });
          return;
        }
        const unsubscribe = this.session.session.subscribe(onEvent);
        try {
          await this.session.session.prompt(request.prompt, { signal: controller.signal });
          this.history?.saveContext(this.session.session.messages, this.session.session.compactionCheckpoint);
          const terminal = [...this.timelineEvents].reverse().find((item) => item.runId === runId && item.event.type === "agent_end");
          const status = terminal?.event.type === "agent_end" && terminal.event.status === "completed" ? "completed" : "interrupted";
          this.history?.saveRun({ type: "run", runId, prompt: request.prompt, status });
        } finally { unsubscribe(); }
      } else {
        await this.createAgent(onEvent, this.projectPath).run(request.prompt, { signal: controller.signal });
      }
    };
    void run()
      .catch((error: unknown) => {
        if (error instanceof HistoryWriteError) {
          this.historyNotice = error.message;
          this.send({ type: "error", requestId: request.requestId, runId, code: "history_write_failed", historyStage: "checkpoint", message: error.message });
          return;
        }
        let historyError: unknown;
        try { this.history?.saveRun({ type: "run", runId, prompt: request.prompt, status: "unknown" }); }
        catch (errorWhileRecording: unknown) { historyError = errorWhileRecording; }
        this.send({
          type: "error",
          requestId: request.requestId,
          runId,
          code: "run_error",
          message: error instanceof Error ? error.message : "The run failed.",
        });
        if (historyError !== undefined) {
          this.historyNotice = historyError instanceof Error ? historyError.message : "历史写入结果未知。";
          this.send({ type: "error", requestId: request.requestId, runId, code: "history_write_failed", historyStage: "checkpoint", message: this.historyNotice });
        }
      })
      .finally(() => {
        if (this.active?.runId === runId) {
          this.active = undefined;
        }
        resolveDone();
      });
  }

  private async selectProject(requestId: string, requestedPath: string): Promise<void> {
    if (this.active !== undefined) {
      this.send({ type: "error", requestId, code: "busy", message: "运行期间不能切换项目。" });
      return;
    }
    try {
      const canonical = await realpath(requestedPath);
      if (!(await stat(canonical)).isDirectory()) throw new Error("所选路径不是目录。");
      if (this.active !== undefined || this.closed) throw new Error("项目状态已改变，请重新选择目录。");
      if (canonical === this.projectPath) {
        this.send({ type: "project-selected", requestId, path: canonical });
        return;
      }
      const nextHistory = this.historyDirectory === undefined ? undefined : DesktopHistory.open(this.historyDirectory, canonical);
      try {
        if (this.historyDirectory !== undefined) saveLastProject(this.historyDirectory, canonical);
      } catch (error: unknown) {
        nextHistory?.close();
        throw error;
      }
      this.history?.close();
      this.history = nextHistory;
      this.projectPath = canonical;
      this.historyNotice = undefined;
      this.loadedHistory = this.history?.snapshot();
      this.timelineEvents = [...(this.loadedHistory?.events ?? [])];
      this.sequence = Math.max(this.sequence, ...this.timelineEvents.map((event) => event.sequence), 0);
      this.session = undefined;
      this.sessionConfigKey = undefined;
      this.send({ type: "project-selected", requestId, path: canonical });
    } catch (error: unknown) {
      this.send({ type: "error", requestId, code: "invalid_project", message: error instanceof Error ? error.message : "无法打开项目目录。" });
    }
  }

  private restoreLastProject(): void {
    if (this.historyDirectory === undefined || this.projectPath !== undefined || this.closed) return;
    try {
      const lastProject = readLastProject(this.historyDirectory);
      if (lastProject === undefined) return;
      const canonical = realpathSync(lastProject);
      if (!statSync(canonical).isDirectory()) return;
      const history = DesktopHistory.open(this.historyDirectory, canonical);
      this.history = history;
      this.projectPath = canonical;
      this.loadedHistory = history.snapshot();
      this.timelineEvents = [...this.loadedHistory.events];
      this.sequence = Math.max(0, ...this.timelineEvents.map((event) => event.sequence));
    } catch (error: unknown) {
      this.historyNotice = `无法恢复上次项目历史：${error instanceof Error ? error.message : "未知错误"}`;
    }
  }

  private snapshot() {
    if (this.projectPath === undefined) return undefined;
    const history = this.history?.snapshot() ?? this.loadedHistory;
    if (history === undefined) return undefined;
    const events = this.timelineEvents;
    const currentRun = this.active === undefined
      ? history.activeRun
      : { runId: this.active.runId, prompt: this.active.prompt, status: "running" as const };
    const runs: Array<{ runId: string; prompt: string; status: "started" | "running" | "completed" | "interrupted" | "unknown" }> = history.runs.map(({ runId, prompt, status }) => ({ runId, prompt, status }));
    if (this.active !== undefined) {
      const previousIndex = runs.findIndex((run) => run.runId === this.active?.runId);
      const activeRun = { runId: this.active.runId, prompt: this.active.prompt, status: "running" as const };
      if (previousIndex === -1) runs.push(activeRun);
      else runs[previousIndex] = activeRun;
    }
    return {
      hostInstanceId: this.instanceId,
      sessionId: history.sessionId,
      projectPath: history.projectPath,
      sequence: this.sequence,
      events: events.map(({ sequence, runId, event }) => ({ sequence, runId, event })),
      ...(currentRun === undefined ? {} : { run: currentRun }),
      runs,
      incomplete: history.incomplete,
      corruption: history.corruption,
      ...((this.historyNotice ?? history.historyNotice) === undefined ? {} : { historyNotice: this.historyNotice ?? history.historyNotice }),
    };
  }

  private sessionId(): string {
    return this.history?.sessionId ?? `session-${createHash("sha256").update(this.projectPath ?? "no-project").digest("hex").slice(0, 24)}`;
  }

  private interrupt(requestId: string, runId: string): void {
    const active = this.active;
    const accepted = active !== undefined && active.runId === runId;
    if (accepted) {
      active.controller.abort();
    }
    this.send({
      type: "interrupted",
      requestId,
      runId,
      accepted,
    });
  }
}

interface ActiveRun {
  readonly runId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

function readRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve({ aborted: false, value }); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Display endpoint location, but never forward URL credentials, query tokens or fragments. */
function safeEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
