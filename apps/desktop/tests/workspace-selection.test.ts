import { describe, expect, it } from "vitest";
import { activeWorkspaceAfterHostReply } from "../src/main/workspace-selection.js";

describe("main process active workspace", () => {
  it("clears the previous workspace when an initialized host has no project snapshot", () => {
    expect(activeWorkspaceAfterHostReply("/old/project", {
      type: "initialized", requestId: "boot", protocolVersion: 1,
      hostInstanceId: "host-next", capabilities: [], defaultProvider: "openai",
    })).toBeUndefined();
  });

  it("tracks selected and restored projects while retaining the path for other replies", () => {
    expect(activeWorkspaceAfterHostReply(undefined, { type: "project-selected", requestId: "select", path: "/project" })).toBe("/project");
    expect(activeWorkspaceAfterHostReply("/old", {
      type: "initialized", requestId: "boot", protocolVersion: 1,
      hostInstanceId: "host-next", capabilities: [], defaultProvider: "openai",
      snapshot: { hostInstanceId: "host-next", sessionId: "session-1", projectPath: "/restored", sequence: 0, events: [], incomplete: false, corruption: null },
    })).toBe("/restored");
    expect(activeWorkspaceAfterHostReply("/project", { type: "shutdown_ack", requestId: "shutdown" })).toBe("/project");
  });
});
