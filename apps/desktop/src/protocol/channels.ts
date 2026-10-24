export const IPC = {
  initialize: "desktop:initialize",
  selectProject: "desktop:select-project",
  start: "desktop:start",
  interrupt: "desktop:interrupt",
  workspaceReview: "desktop:workspace-review",
  openWorkspaceFile: "desktop:open-workspace-file",
  event: "desktop:event",
  hostStatus: "desktop:host-status",
} as const;
