export type ApprovalDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: "user" | "cancelled" | "unavailable" | "unreviewable" };

/** Keep boolean approval callbacks compatible while never treating objects as truthy grants. */
export type ShellApproval = (command: string, signal?: AbortSignal, context?: string) => Promise<boolean | ApprovalDecision>;

export function approvalWasGranted(value: boolean | ApprovalDecision): value is true | { readonly approved: true } {
  return value === true || (typeof value === "object" && value.approved === true);
}

/**
 * Shell permission is scoped to the current CLI process. Interactive sessions
 * install a per-command prompt; headless sessions deny unless the user passes
 * the explicit session-wide approval flag.
 */
export class ShellApprovalGate {
  private handler: ShellApproval | undefined;

  constructor(private readonly approveAll = false) {}

  setHandler(handler: ShellApproval | undefined): void {
    this.handler = handler;
  }

  async approveDecision(command: string, signal?: AbortSignal, context?: string): Promise<ApprovalDecision> {
    if (signal?.aborted) return { approved: false, reason: "cancelled" };
    if (this.approveAll) return { approved: true };
    if (this.handler === undefined) return { approved: false, reason: "unavailable" };
    const result = await this.handler(command, signal, context);
    if (signal?.aborted) return { approved: false, reason: "cancelled" };
    if (typeof result === "boolean") return result ? { approved: true } : { approved: false, reason: "user" };
    return result;
  }

  async approve(command: string, signal?: AbortSignal, context?: string): Promise<boolean> {
    return approvalWasGranted(await this.approveDecision(command, signal, context));
  }
}
