import { randomBytes } from "node:crypto";
import type { Agent } from "@chivgent/agent.ts";
import type { AgentEvent } from "@chivgent/events.ts";
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
}

export interface HostServiceOptions {
  readonly send: (message: HostToMain) => void;
  readonly createAgent: (onEvent: (event: AgentEvent) => void) => Agent;
  readonly createId?: () => string;
}

/**
 * Owns one stub run at a time. The Agent is the only thing that decides
 * completion; this class only correlates requestId, runId, and sequence.
 */
export class HostService {
  readonly instanceId: string;
  private readonly send: (message: HostToMain) => void;
  private readonly createAgent: HostServiceOptions["createAgent"];
  private readonly createId: () => string;
  private readonly accepted = new Map<string, AcceptedStart>();
  private active: ActiveRun | undefined;
  private sequence = 0;
  private closed = false;

  constructor(options: HostServiceOptions) {
    this.send = options.send;
    this.createAgent = options.createAgent;
    this.createId = options.createId ?? (() => randomBytes(8).toString("hex"));
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
        this.send({
          type: "initialized",
          requestId: request.requestId,
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          hostInstanceId: this.instanceId,
          capabilities: HOST_CAPABILITIES,
        });
        return;
      case "start":
        this.start(request);
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
    this.send({ type: "shutdown_ack", requestId });
  }

  private start(request: StartRequest): void {
    const previous = this.accepted.get(request.requestId);
    if (previous !== undefined) {
      if (previous.prompt !== request.prompt) {
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

    const runId = `run-${this.createId()}`;
    const accepted: AcceptedStart = {
      requestId: request.requestId,
      runId,
      prompt: request.prompt,
    };
    this.accepted.set(request.requestId, accepted);
    const controller = new AbortController();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active = { runId, controller, done };
    this.send({
      type: "started",
      requestId: request.requestId,
      runId,
      replayed: false,
    });

    const agent = this.createAgent((event) => {
      this.sequence += 1;
      this.send({
        type: "event",
        runId,
        sequence: this.sequence,
        event,
      });
    });

    void agent
      .run(request.prompt, { signal: controller.signal })
      .catch((error: unknown) => {
        this.send({
          type: "error",
          requestId: request.requestId,
          runId,
          code: "run_error",
          message: error instanceof Error ? error.message : "The run failed.",
        });
      })
      .finally(() => {
        if (this.active?.runId === runId) {
          this.active = undefined;
        }
        resolveDone();
      });
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
