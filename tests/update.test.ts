import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { runUpdate } from "../src/update.js";

let directory: string;
let prefix: string;
let root: string;
let output: string;
let errors: string;
let latest: unknown;
let installVersion: string;
let npm: ReturnType<typeof vi.fn<(args: readonly string[], timeout: number) => Promise<string>>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chivgent-update-"));
  prefix = join(directory, "global prefix");
  root = join(prefix, "lib/node_modules/chivgent");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.18.1" }));
  output = "";
  errors = "";
  installVersion = "0.19.0";
  latest = { version: "0.19.0", engines: { node: ">=22" } };
  npm = vi.fn(async (args) => {
    if (args[0] === "prefix") return `${prefix}\n`;
    if (args[0] === "root") return `${join(prefix, "lib/node_modules")}\n`;
    if (args[0] === "view") return JSON.stringify(latest);
    if (args[0] === "install") {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: installVersion }));
      return "installed";
    }
    throw new Error("Unexpected npm command");
  });
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function run(args: readonly string[] = [], packageRoot = root, version = "0.18.1") {
  return runUpdate(args, { packageRoot, version, nodeVersion: "22.20.0", npm,
    write: (text) => { output += text; }, error: (text) => { errors += text; },
  });
}

describe("update command", () => {
  it("installs the checked version in the matching global prefix and verifies it", async () => {
    expect(await run()).toBe(0);
    expect(npm).toHaveBeenLastCalledWith([
      "install", "--global", "--prefix", prefix, "chivgent@0.19.0",
      "--engine-strict", "--no-audit", "--no-fund",
    ], 300_000);
    expect(output).toContain("Updated to 0.19.0. Restart chivgent");
    expect(errors).toBe("");
  });

  it("checks without writing the installation", async () => {
    expect(await run(["--check"])).toBe(0);
    expect(npm.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.18.1");
    expect(output).toContain("Update available");
  });

  it.each(["0.19.0", "0.20.0", "0.20.0-beta.1"])("never reinstalls or downgrades %s", async (version) => {
    expect(await run([], root, version)).toBe(0);
    expect(npm.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
    expect(output).toContain(version === "0.19.0" ? "Already up to date" : "no downgrade");
  });

  it("upgrades a prerelease to the corresponding stable version", async () => {
    expect(await run([], root, "0.19.0-beta.1")).toBe(0);
    expect(output).toContain("Updated to 0.19.0");
  });

  it("compares version components numerically", async () => {
    latest = { version: "0.20.0" };
    installVersion = "0.20.0";
    expect(await run([], root, "0.9.0")).toBe(0);
    expect(output).toContain("Updated to 0.20.0");
  });

  it.each([{ args: [] }, { args: ["--check"] }])("blocks unsupported Node versions for $args", async ({ args }) => {
    latest = { version: "0.19.0", engines: { node: ">=24" } };
    expect(await run(args)).toBe(1);
    expect(errors).toContain("Upgrade Node.js first");
    expect(npm.mock.calls.some(([call]) => call[0] === "install")).toBe(false);
  });

  it.each([null, {}, { version: "bad" }, { version: "1.0.0; echo unsafe" },
    { version: "0.19.0", engines: { node: "bad" } }])("rejects malformed registry metadata: %j", async (metadata) => {
    latest = metadata;
    expect(await run()).toBe(1);
    expect(npm.mock.calls.some(([args]) => args[0] === "install")).toBe(false);
    expect(errors).toMatch(/npm returned (an )?invalid/);
  });

  it.each(["source", "cache/_npx/123/node_modules/chivgent"])("provides offline guidance for %s", async (location) => {
    const source = join(directory, location);
    await mkdir(source, { recursive: true });
    expect(await run([], source)).toBe(0);
    expect(npm).not.toHaveBeenCalled();
    expect(output).toContain(location === "source" ? "git pull --ff-only" : "npx chivgent@latest");
  });

  it("leaves local dependencies untouched even if another global copy exists", async () => {
    const local = join(directory, "project/node_modules/chivgent");
    await mkdir(local, { recursive: true });
    expect(await run([], local)).toBe(0);
    expect(output).toContain("not the active npm global installation");
    expect(npm.mock.calls.map(([args]) => args[0])).toEqual(["prefix", "root"]);
  });

  it("does not replace linked installs, including links to other node_modules", async () => {
    const linked = join(directory, "other/node_modules/chivgent");
    await mkdir(linked, { recursive: true });
    await rm(root, { recursive: true });
    await symlink(linked, root, "junction");
    expect(await run([], root)).toBe(0);
    expect(npm.mock.calls.map(([args]) => args[0])).toEqual(["prefix", "root"]);
  });

  it("provides guidance when the active global prefix has no chivgent", async () => {
    const local = join(directory, "project/node_modules/chivgent");
    await mkdir(local, { recursive: true });
    await rm(root, { recursive: true });
    expect(await run([], local)).toBe(0);
    expect(output).toContain("not the active npm global installation");
  });

  it("reports a missing npm executable and a manual command", async () => {
    npm.mockRejectedValue(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
    expect(await run()).toBe(1);
    expect(errors).toContain("npm ENOENT");
    expect(errors).toContain("npm install -g chivgent@latest");
  });

  it.each(["view", "install"])("reports failures during %s without claiming success", async (failedCommand) => {
    const delegate = npm.getMockImplementation()!;
    npm.mockImplementation(async (args, timeout) => {
      if (args[0] === failedCommand) throw new Error(failedCommand === "view" ? "ETIMEDOUT" : "EACCES");
      return delegate(args, timeout);
    });
    expect(await run()).toBe(1);
    expect(output).not.toContain("Updated to");
    expect(errors).toContain(failedCommand === "view" ? "ETIMEDOUT" : "EACCES");
  });

  it("does not claim success if npm did not replace the installed version", async () => {
    installVersion = "0.18.1";
    expect(await run()).toBe(1);
    expect(errors).toContain("verify the installed version");
    expect(output).not.toContain("Updated to");
  });

  it.each([["--help"], ["-h"], ["--unknown"], ["--check", "extra"], ["this", "file"]].map((args) => ({ args })))("handles arguments before invoking npm: $args", async ({ args }) => {
    const help = args[0] === "--help" || args[0] === "-h";
    expect(await run(args)).toBe(help ? 0 : 1);
    expect(npm).not.toHaveBeenCalled();
    expect(output + errors).toContain("Usage: chivgent update");
  });

  it("keeps update questions available through the option terminator", () => {
    expect(parseCliArgs(["--", "update"], {}).prompt).toBe("update");
    expect(parseCliArgs(["--", "update", "--this"], {}).prompt).toBe("update --this");
    expect(parseCliArgs(["update this file"], {}).prompt).toBe("update this file");
  });
});
