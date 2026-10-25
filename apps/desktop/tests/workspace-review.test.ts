import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceReview } from "../src/host/workspace-review.js";
import { isForbiddenDesktopReviewPath } from "../src/workspace-policy.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-review-")));
  roots.push(root);
  return root;
}
async function git(cwd: string, ...args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

describe("workspace review", () => {
  it("shows staged, unstaged, and bounded untracked text changes", async () => {
    const root = temporaryRoot();
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    writeFileSync(join(root, ".env"), "base env\n");
    mkdirSync(join(root, ".ssh")); writeFileSync(join(root, ".ssh", "id_ed25519"), "base key\n");
    mkdirSync(join(root, ".agents")); writeFileSync(join(root, ".agents", "private.txt"), "base agents\n");
    mkdirSync(join(root, ".codex")); writeFileSync(join(root, ".codex", "private.txt"), "base codex\n");
    await git(root, "add", "tracked.txt", ".env", ".ssh/id_ed25519", ".agents/private.txt", ".codex/private.txt"); await git(root, "commit", "-qm", "base");
    writeFileSync(join(root, "tracked.txt"), "staged\n"); await git(root, "add", "tracked.txt");
    writeFileSync(join(root, "tracked.txt"), "working\n");
    writeFileSync(join(root, ".env"), "STAGED_ENV_SECRET\n"); await git(root, "add", ".env");
    writeFileSync(join(root, ".env"), "UNSTAGED_ENV_SECRET\n");
    writeFileSync(join(root, ".ssh", "id_ed25519"), "STAGED_SSH_SECRET\n"); await git(root, "add", ".ssh/id_ed25519");
    writeFileSync(join(root, ".ssh", "id_ed25519"), "UNSTAGED_SSH_SECRET\n");
    writeFileSync(join(root, ".agents", "private.txt"), "STAGED_AGENTS_SECRET\n"); await git(root, "add", ".agents/private.txt");
    writeFileSync(join(root, ".agents", "private.txt"), "UNSTAGED_AGENTS_SECRET\n");
    writeFileSync(join(root, ".codex", "private.txt"), "STAGED_CODEX_SECRET\n"); await git(root, "add", ".codex/private.txt");
    writeFileSync(join(root, ".codex", "private.txt"), "UNSTAGED_CODEX_SECRET\n");
    writeFileSync(join(root, "new.txt"), "untracked text\n");
    const result = await readWorkspaceReview(root);
    expect(result.kind).toBe("git");
    if (result.kind !== "git") return;
    expect(result.staged).toContain("staged");
    expect(result.unstaged).toContain("working");
    for (const secret of ["STAGED_ENV_SECRET", "UNSTAGED_ENV_SECRET", "STAGED_SSH_SECRET", "UNSTAGED_SSH_SECRET", "STAGED_AGENTS_SECRET", "UNSTAGED_AGENTS_SECRET", "STAGED_CODEX_SECRET", "UNSTAGED_CODEX_SECRET"]) {
      expect(result.staged).not.toContain(secret);
      expect(result.unstaged).not.toContain(secret);
    }
    expect(result.untracked).toContainEqual(expect.objectContaining({ path: "new.txt", kind: "text", content: "untracked text\n" }));
  });

  it("returns explicit non-git, empty, oversized, binary, and unsafe path states", async () => {
    const nonGit = temporaryRoot();
    expect(await readWorkspaceReview(nonGit)).toMatchObject({ kind: "not-git" });
    const root = temporaryRoot(); await git(root, "init", "-q");
    expect(await readWorkspaceReview(root)).toMatchObject({ kind: "git", staged: "", unstaged: "", untracked: [] });
    writeFileSync(join(root, "large.txt"), "x".repeat(300_000));
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, ".env"), "SECRET_ENV_VALUE");
    mkdirSync(join(root, ".ssh")); writeFileSync(join(root, ".ssh", "id_ed25519"), "SECRET_SSH_VALUE");
    mkdirSync(join(root, ".agents")); writeFileSync(join(root, ".agents", "secret.txt"), "SECRET_AGENTS_VALUE");
    mkdirSync(join(root, ".codex")); writeFileSync(join(root, ".codex", "secret.txt"), "SECRET_CODEX_VALUE");
    const outside = join(temporaryRoot(), "outside.txt"); writeFileSync(outside, "OUTSIDE_PATH_SECRET_VALUE");
    symlinkSync(outside, join(root, "escape.txt"));
    const result = await readWorkspaceReview(root);
    expect(result.kind).toBe("git");
    if (result.kind !== "git") return;
    expect(result.untracked).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "large.txt", kind: "too-large" }),
      expect.objectContaining({ path: "binary.bin", kind: "binary" }),
      expect.objectContaining({ path: "escape.txt", kind: "unsafe" }),
    ]));
    for (const protectedPath of [".env", ".ssh/id_ed25519", ".agents/secret.txt", ".codex/secret.txt"]) {
      expect(JSON.stringify(result)).not.toContain(protectedPath);
    }
    expect(JSON.stringify(result)).not.toContain("OUTSIDE_PATH_SECRET_VALUE");
    expect(JSON.stringify(result)).not.toContain("SECRET_ENV_VALUE");
    expect(JSON.stringify(result)).not.toContain("SECRET_SSH_VALUE");
    expect(JSON.stringify(result)).not.toContain("SECRET_AGENTS_VALUE");
    expect(JSON.stringify(result)).not.toContain("SECRET_CODEX_VALUE");
  });

  it("does not classify a workspace realpath failure as a non-Git folder", async () => {
    const missing = join(temporaryRoot(), "removed-project");
    await expect(readWorkspaceReview(missing)).rejects.toThrow("Unable to resolve workspace path.");
  });

  it("treats agent and app metadata directories as protected review paths", () => {
    expect(isForbiddenDesktopReviewPath(".agents/session.json")).toBe(true);
    expect(isForbiddenDesktopReviewPath(".codex/private.txt")).toBe(true);
    expect(isForbiddenDesktopReviewPath("src/main.ts")).toBe(false);
  });
});
