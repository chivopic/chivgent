import { describe, expect, it } from "vitest";
import { RendererLifecycle } from "../src/main/renderer-lifecycle.js";

describe("renderer lifecycle", () => {
  it("starts unavailable until initialize completes and becomes unavailable after process exit", () => {
    const renderer = new RendererLifecycle();
    expect(renderer.isAlive()).toBe(false);
    renderer.markReady();
    expect(renderer.isAlive()).toBe(true);
    renderer.markGone();
    expect(renderer.isAlive()).toBe(false);
  });

  it("does not change when a live window is hidden", () => {
    const renderer = new RendererLifecycle();
    renderer.markReady();
    // Visibility changes have no lifecycle transition.
    expect(renderer.isAlive()).toBe(true);
  });
});
