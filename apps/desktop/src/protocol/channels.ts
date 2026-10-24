export const IPC = {
  initialize: "desktop:initialize",
  selectProject: "desktop:select-project",
  saveProviderProfile: "desktop:save-provider-profile",
  start: "desktop:start",
  interrupt: "desktop:interrupt",
  approvalRespond: "desktop:approval-respond",
  workspaceReview: "desktop:workspace-review",
  openWorkspaceFile: "desktop:open-workspace-file",
  event: "desktop:event",
  hostStatus: "desktop:host-status",
} as const;
