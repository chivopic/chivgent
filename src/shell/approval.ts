/** Every shell call requires a positive user decision. */
export type ShellApproval = (command: string, signal?: AbortSignal) => Promise<boolean>;

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

  async approve(command: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.approveAll) return true;
    if (this.handler === undefined) return false;
    return (await this.handler(command, signal)) && signal?.aborted !== true;
  }
}
