import type { ApprovalDecision } from "@chivgent/shell/approval.js";

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly action: string;
  readonly context: string;
  readonly signal?: AbortSignal;
}

/** A one-shot, abortable broker. A missing consumer or any close fails closed. */
export class ApprovalBroker {
  private readonly pending = new Map<string, { resolve: (decision: ApprovalDecision) => void; signal?: AbortSignal; abort?: () => void }>();
  private closed = false;

  constructor(private readonly publish: (request: Omit<ApprovalRequest, "signal">) => void) {}

  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.closed || request.signal?.aborted) return Promise.resolve({ approved: false, reason: "cancelled" });
    if (this.pending.has(request.approvalId)) return Promise.resolve({ approved: false, reason: "unavailable" });
    return new Promise((resolve) => {
      const abort = (): void => {
        const pending = this.pending.get(request.approvalId);
        if (!pending) return;
        this.pending.delete(request.approvalId);
        resolve({ approved: false, reason: "cancelled" });
      };
      if (request.signal) request.signal.addEventListener("abort", abort, { once: true });
      this.pending.set(request.approvalId, { resolve, ...(request.signal === undefined ? {} : { signal: request.signal, abort }) });
      try {
        this.publish({ approvalId: request.approvalId, action: request.action, context: request.context });
      } catch {
        this.pending.delete(request.approvalId);
        if (request.signal && abort) request.signal.removeEventListener("abort", abort);
        resolve({ approved: false, reason: "unavailable" });
      }
    });
  }

  respond(approvalId: string, approved: boolean): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending || this.closed) return false;
    this.pending.delete(approvalId);
    if (pending.signal !== undefined && pending.abort !== undefined) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(approved ? { approved: true } : { approved: false, reason: "user" });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.signal !== undefined && pending.abort !== undefined) pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ approved: false, reason: "cancelled" });
    }
    this.pending.clear();
  }

  get size(): number { return this.pending.size; }
}
