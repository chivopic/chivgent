import { describe, expect, it, vi } from "vitest";
import { routeApproval } from "../src/main/approval-routing.js";
import { RendererLifecycle } from "../src/main/renderer-lifecycle.js";
import type { HostToMain } from "../src/protocol/messages.js";

const approval = {
  type: "approval",
  hostInstanceId: "host-1",
  sessionId: "session-1",
  runId: "run-1",
  approvalId: "approval-1",
  action: "Write file",
  context: "/tmp/project",
} satisfies Extract<HostToMain, { type: "approval" }>;

describe("main-process approval routing", () => {
  it("rejects correlated approval immediately when the renderer is destroyed", () => {
    const remember = vi.fn();
    const reject = vi.fn();
    const forward = vi.fn();
    routeApproval(approval, () => false, remember, reject, forward);
    expect(reject).toHaveBeenCalledWith(approval);
    expect(remember).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("rejects when the renderer process is gone although its WebContents is not destroyed", () => {
    const lifecycle = new RendererLifecycle();
    lifecycle.markReady();
    lifecycle.markGone();
    const remember = vi.fn();
    const reject = vi.fn();
    const forward = vi.fn();
    const webContentsAlive = true;
    routeApproval(approval, () => lifecycle.isAlive() && webContentsAlive, remember, reject, forward);
    expect(reject).toHaveBeenCalledWith(approval);
    expect(remember).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("keeps approvals routable when the renderer is live, including a hidden window", () => {
    const lifecycle = new RendererLifecycle();
    lifecycle.markReady();
    const calls: string[] = [];
    routeApproval(approval, () => lifecycle.isAlive(), () => calls.push("remember"), () => calls.push("reject"), () => calls.push("forward"));
    expect(calls).toEqual(["remember", "forward"]);
  });
});
