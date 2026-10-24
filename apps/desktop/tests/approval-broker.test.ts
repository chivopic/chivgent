import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../src/host/approval-broker.js";

describe("desktop approval broker", () => {
  it("consumes a matching decision once and ignores stale replies", async () => {
    const publish = vi.fn();
    const broker = new ApprovalBroker(publish);
    const decision = broker.request({ approvalId: "approval-1", action: "Edit a.txt", context: "/tmp/project" });
    expect(publish).toHaveBeenCalledWith({ approvalId: "approval-1", action: "Edit a.txt", context: "/tmp/project" });
    expect(broker.respond("wrong", true)).toBe(false);
    expect(broker.respond("approval-1", true)).toBe(true);
    expect(broker.respond("approval-1", true)).toBe(false);
    await expect(decision).resolves.toEqual({ approved: true });
  });

  it("denies on cancellation, close, and unavailable publication", async () => {
    const controller = new AbortController();
    const broker = new ApprovalBroker(() => {});
    const cancelled = broker.request({ approvalId: "cancel", action: "write", context: "project", signal: controller.signal });
    controller.abort();
    await expect(cancelled).resolves.toEqual({ approved: false, reason: "cancelled" });
    const closing = broker.request({ approvalId: "close", action: "write", context: "project" });
    broker.close();
    await expect(closing).resolves.toEqual({ approved: false, reason: "cancelled" });
    const failed = new ApprovalBroker(() => { throw new Error("renderer unavailable"); });
    await expect(failed.request({ approvalId: "no-channel", action: "write", context: "project" }))
      .resolves.toEqual({ approved: false, reason: "unavailable" });
  });
});
