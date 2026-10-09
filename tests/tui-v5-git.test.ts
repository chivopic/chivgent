import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readLiveGitDiff } from "../src/tui/git-diff.js";
import { reviewFrame } from "../src/tui/review.js";

const folders: string[] = [];
async function gitRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "chivgent-git-review-"));
  folders.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", timeout: 5_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  git("init", "-q");
  git("-c", "user.name=Chivgent Test", "-c", "user.email=test@example.com", "config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "tracked.txt"), "old\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Chivgent Test", "-c", "user.email=test@example.com", "commit", "-qm", "init");
  return { dir, git };
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive:true, force:true })));
});

describe("explicitly authorized read-only worktree git diff", () => {
  it("compares unstaged/staged files independently without touching the worktree", async () => {
    const {dir,git} = await gitRepo();
    await writeFile(path.join(dir, "tracked.txt"), "new\n");
    const unstaged = await readLiveGitDiff(dir, "working");
    expect(unstaged).toContain("-old");
    expect(unstaged).toContain("+new");
    expect(await readLiveGitDiff(dir, "staged")).toBe("");
    git("add", "tracked.txt");
    expect(await readLiveGitDiff(dir, "working")).toBe("");
    const staged = await readLiveGitDiff(dir, "staged");
    expect(staged).toContain("+new");
    expect(git("status", "--porcelain")).toContain("M  tracked.txt");
    expect(reviewFrame(staged, 1, 60, 18, false, "live Git diff (staged)").lines[0])
      .toContain("live Git diff");
  });

  it("does not run .gitattributes external diff drivers or load untracked files", async () => {
    const {dir,git} = await gitRepo();
    const marker = path.join(dir, "external-ran");
    await writeFile(path.join(dir, ".gitattributes"), "tracked.txt diff=custom\n");
    git("config", "diff.custom.command", `sh -c 'touch "${marker}"'`);
    await writeFile(path.join(dir, "tracked.txt"), "changed\n");
    await writeFile(path.join(dir, "untracked-secret.txt"), "SECRET_TOKEN_42");
    const diff = await readLiveGitDiff(dir, "working");
    expect(diff).toContain("+changed");
    expect(diff).not.toContain("SECRET_TOKEN_42");
    await expect(import("node:fs/promises").then(fs => fs.stat(marker))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("rejects nonexistent workspaces without exposing filesystem paths", async () => {
    await expect(readLiveGitDiff("/nonexistent/chivgent-ghost-dir", "working")).rejects.toThrow();
  });
});
