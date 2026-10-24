import { describe, expect, it } from "vitest";
import { isForbiddenDesktopReviewPath } from "../src/workspace-policy.js";

describe("Desktop review path policy", () => {
  it("blocks sensitive credential and metadata paths at every level", () => {
    for (const path of [".env", "config/.env.production", ".ssh/id_ed25519", "nested/.AWS/credentials", ".agents/session.json", "project/.codex/private.json"]) {
      expect(isForbiddenDesktopReviewPath(path), path).toBe(true);
    }
  });

  it("keeps the documented safe env examples and ordinary project files reviewable", () => {
    expect(isForbiddenDesktopReviewPath(".env.example")).toBe(false);
    expect(isForbiddenDesktopReviewPath("src/main.ts")).toBe(false);
  });
});
