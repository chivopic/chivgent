import type { HostToMain } from "../protocol/messages.js";

type Approval = Extract<HostToMain, { type: "approval" }>;

/** Route approvals only to a live renderer; a hidden window remains eligible. */
export function routeApproval(
  approval: Approval,
  rendererAvailable: () => boolean,
  remember: (approval: Approval) => void,
  reject: (approval: Approval) => void,
  forward: (approval: Approval) => void,
): void {
  if (!rendererAvailable()) {
    reject(approval);
    return;
  }
  remember(approval);
  forward(approval);
}
