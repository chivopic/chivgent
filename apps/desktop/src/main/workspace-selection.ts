import type { HostToMain } from "../protocol/messages.js";

export function activeWorkspaceAfterHostReply(
  current: string | undefined,
  message: HostToMain,
): string | undefined {
  if (message.type === "project-selected") return message.path;
  if (message.type === "initialized") return message.snapshot?.projectPath;
  return current;
}
