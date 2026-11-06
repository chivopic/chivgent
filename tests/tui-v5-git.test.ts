import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink, unlink } from "node:fs/promises";
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

  it("shows staged, unstaged, and safe untracked changes without collapsing index state", async () => {
    const {dir,git} = await gitRepo();
    await writeFile(path.join(dir, "tracked.txt"), "staged\n");
    git("add", "tracked.txt");
    await writeFile(path.join(dir, "tracked.txt"), "worktree\n");
    await writeFile(path.join(dir, "new file.txt"), "untracked\n");
    await writeFile(path.join(dir, ".env"), "PRIVATE_ENV_TOKEN");
    await mkdir(path.join(dir, ".ssh"), {recursive:true});
    await writeFile(path.join(dir, ".ssh", "id_ed25519"), "PRIVATE_SSH_TOKEN");

    const diff = await readLiveGitDiff(dir, "all");
    expect(diff).toContain("staged");
    expect(diff).toContain("worktree");
    expect(diff).toContain("untracked");
    expect(diff).toContain("protected workspace path");
    expect(diff).not.toContain("PRIVATE_ENV_TOKEN");
    expect(diff).not.toContain("PRIVATE_SSH_TOKEN");
    expect(git("status", "--porcelain")).toContain("MM tracked.txt");
  });

  it("represents renames as staged delete/add pairs and includes unstaged deletions", async () => {
    const {dir, git} = await gitRepo();
    git("mv", "tracked.txt", "renamed.txt");
    const renamed = await readLiveGitDiff(dir, "all");
    expect(renamed).toContain("deleted file mode");
    expect(renamed).toContain("new file mode");
    await unlink(path.join(dir, "renamed.txt"));
    const deleted = await readLiveGitDiff(dir, "all");
    expect(deleted).toContain("deleted file mode");
    expect(git("status", "--porcelain")).toContain("D ");
  });

  it("does not run .gitattributes external diff drivers or load untracked files", async () => {
    const {dir,git} = await gitRepo();
    const externalMarker = path.join(dir, "external-ran");
    const cleanMarker = path.join(dir, "clean-ran");
    const processMarker = path.join(dir, "process-ran");
    const includedMarker = path.join(dir, "included-ran");
    await writeFile(path.join(dir, ".gitattributes"), "tracked.txt diff=custom filter=custom\n");
    git("config", "diff.custom.command", `sh -c 'touch "${externalMarker}"'`);
    git("config", "filter.custom.clean", `sh -c 'touch "${cleanMarker}"; cat'`);
    git("config", "filter.custom.process", `sh -c 'touch "${processMarker}"; cat'`);
    const includeConfig = path.join(dir, "filter-include.cfg");
    await writeFile(includeConfig,
      `[filter "custom"]\nclean = sh -c 'touch "${includedMarker}"; cat'\nrequired = true\n`);
    git("config", "include.path", includeConfig);
    await writeFile(path.join(dir, "tracked.txt"), "changed\n");
    await writeFile(path.join(dir, "untracked-secret.txt"), "SECRET_TOKEN_42");
    const diff = await readLiveGitDiff(dir, "working");
    expect(diff).toContain("+changed");
    expect(diff).not.toContain("SECRET_TOKEN_42");
    const completeDiff = await readLiveGitDiff(dir, "all");
    expect(completeDiff).toContain("SECRET_TOKEN_42");
    for (const marker of [externalMarker, cleanMarker, processMarker, includedMarker]) {
      await expect(import("node:fs/promises").then(fs => fs.stat(marker))).rejects.toMatchObject({code:"ENOENT"});
    }
  });

  it("marks skipped symlinks and binary files, and safely quotes unusual names", async () => {
    const {dir} = await gitRepo();
    const outside = await mkdtemp(path.join(tmpdir(), "chivgent-outside-"));
    folders.push(outside);
    await writeFile(path.join(outside, "secret"), "OUTSIDE_SECRET");
    await symlink(outside, path.join(dir, "linked-dir"));
    await writeFile(path.join(dir, "line\nbreak-雪.txt"), "unicode name\n");
    await writeFile(path.join(dir, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(dir, "empty.txt"), "");
    await writeFile(path.join(dir, "no-newline.txt"), "last line");
    await writeFile(path.join(dir, "invalid-utf8.txt"), Buffer.from([0x66, 0xff]));
    const diff = await readLiveGitDiff(dir, "all");
    expect(diff).toContain('"line\\nbreak-雪.txt"');
    expect(diff).toContain("Untracked binary file");
    expect(diff).toContain("Untracked binary or invalid UTF-8 file");
    expect(diff).toContain("\\ No newline at end of file");
    expect(diff).toContain("b/\"empty.txt\"");
    expect(diff).not.toContain('+""');
    expect(diff).toContain("symlink or non-regular file");
    expect(diff).not.toContain("OUTSIDE_SECRET");
  });

  it("limits untracked collection to the requested repository subdirectory", async () => {
    const {dir} = await gitRepo();
    const subdir = path.join(dir, "subdir");
    await mkdir(subdir);
    await writeFile(path.join(subdir, "inside.txt"), "inside marker\n");
    await writeFile(path.join(dir, "sibling.txt"), "OUTSIDE_SUBTREE_MARKER\n");
    const diff = await readLiveGitDiff(subdir, "all");
    expect(diff).toContain("inside marker");
    expect(diff).not.toContain("OUTSIDE_SUBTREE_MARKER");
  });

  it("bounds the combined staged and unstaged review output", async () => {
    const {dir, git} = await gitRepo();
    await writeFile(path.join(dir, "second.txt"), "old second\n");
    git("add", "second.txt");
    git("-c", "user.name=Chivgent Test", "-c", "user.email=test@example.com", "commit", "-qm", "second file");
    await writeFile(path.join(dir, "tracked.txt"), "s".repeat(130 * 1024));
    git("add", "tracked.txt");
    await writeFile(path.join(dir, "second.txt"), "w".repeat(130 * 1024));
    await expect(readLiveGitDiff(dir, "all")).rejects.toThrow("Git review exceeds the 256 KiB limit");
  });

  it("disables a clean filter defined by linked-worktree configuration", async () => {
    const {dir, git} = await gitRepo();
    await writeFile(path.join(dir, ".gitattributes"), "tracked.txt filter=linked\n");
    git("add", ".gitattributes");
    git("-c", "user.name=Chivgent Test", "-c", "user.email=test@example.com", "commit", "-qm", "attributes");
    git("config", "extensions.worktreeConfig", "true");
    const linked = await mkdtemp(path.join(tmpdir(), "chivgent-linked-worktree-"));
    folders.push(linked);
    await rm(linked, {recursive:true, force:true});
    git("worktree", "add", "-q", "-b", "filter-test", linked);
    const marker = path.join(dir, "linked-filter-ran");
    execFileSync("git", ["config", "--worktree", "filter.linked.clean", `sh -c 'touch "${marker}"; cat'`], {
      cwd: linked, encoding: "utf8", timeout: 5_000,
      env: {PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"},
    });
    execFileSync("git", ["config", "--worktree", "filter.linked.required", "true"], {
      cwd: linked, encoding: "utf8", timeout: 5_000,
      env: {PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"},
    });
    await writeFile(path.join(linked, "tracked.txt"), "changed in worktree\n");
    const diff = await readLiveGitDiff(linked, "working");
    expect(diff).toContain("changed in worktree");
    await expect(import("node:fs/promises").then(fs => fs.stat(marker))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("rejects nonexistent workspaces without exposing filesystem paths", async () => {
    await expect(readLiveGitDiff("/nonexistent/chivgent-ghost-dir", "working")).rejects.toThrow();
  });
});
