import { readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashTool } from "../src/tools/bash.js";
import type { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-bash-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** The shell tool never touches the workspace; it only needs the object to exist. */
const unusedWorkspace = {} as Workspace;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Polls until the process is gone, so the assertion does not race the kill. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(25);
  }
  return false;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BashTool", () => {
  it("returns the output of a successful command", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "echo hello" },
      { workspace: unusedWorkspace },
    );

    expect(result).toEqual({ content: "hello\n", isError: false });
  });

  it("interleaves stderr with stdout", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "echo out; echo err 1>&2" },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("out");
    expect(result.content).toContain("err");
  });

  it("runs in the configured working directory", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "pwd" },
      { workspace: unusedWorkspace },
    );

    // macOS reports /private/var for /var, so compare the resolved tail.
    expect(result.content.trim().endsWith(path.basename(cwd))).toBe(true);
  });

  it("reports a non-zero exit code and still returns the output", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "echo before failing; exit 3" },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("before failing");
    expect(result.content).toContain("Command exited with code 3");
  });

  it("says so when a command prints nothing", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "true" },
      { workspace: unusedWorkspace },
    );

    expect(result).toEqual({ content: "(no output)", isError: false });
  });

  it("streams progress before it finishes", async () => {
    const cwd = await temporaryDirectory();
    const updates: string[] = [];

    const result = await new BashTool({ cwd, throttleMs: 0 }).execute(
      { command: "echo first; sleep 0.2; echo second" },
      {
        workspace: unusedWorkspace,
        onUpdate: (content) => updates.push(content),
      },
    );

    expect(updates.length).toBeGreaterThan(0);
    // The first snapshot arrived before the command had printed everything.
    expect(updates[0]).toContain("first");
    expect(updates[0]).not.toContain("second");
    expect(result.content).toContain("second");
  });

  it("throttles progress snapshots", async () => {
    const cwd = await temporaryDirectory();
    const updates: string[] = [];

    await new BashTool({ cwd, throttleMs: 10_000 }).execute(
      { command: "for i in 1 2 3 4 5; do echo line $i; done" },
      {
        workspace: unusedWorkspace,
        onUpdate: (content) => updates.push(content),
      },
    );

    // One immediate snapshot plus the final flush, never one per line.
    expect(updates.length).toBeLessThanOrEqual(2);
  });

  it("times out and keeps what the command already printed", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "echo starting; sleep 30", timeout: 1 },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("starting");
    expect(result.content).toContain("timed out after 1 seconds");
  });

  it("kills the whole process tree when the run is aborted", async () => {
    const cwd = await temporaryDirectory();
    const pidFile = path.join(cwd, "child.pid");
    const controller = new AbortController();

    const execution = new BashTool({ cwd }).execute(
      { command: `sleep 30 & echo $! > ${pidFile}; wait` },
      { workspace: unusedWorkspace, signal: controller.signal },
    );

    // Wait for the grandchild to exist before cancelling.
    let grandchildPid: number | undefined;
    for (let attempt = 0; attempt < 100 && grandchildPid === undefined; attempt += 1) {
      try {
        const contents = await readFile(pidFile, "utf8");
        const parsed = Number.parseInt(contents.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          grandchildPid = parsed;
        }
      } catch {
        await delay(25);
      }
    }
    expect(grandchildPid).toBeDefined();

    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });

    // The point of the process group: the sleep must be gone too, not just
    // the shell that started it.
    expect(await waitForExit(grandchildPid as number)).toBe(true);
  });

  it("truncates long output and keeps the full text on disk", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({
      cwd,
      maxLines: 5,
      maxBytes: 10_000,
      tempDirectory: cwd,
    }).execute(
      { command: "for i in $(seq 1 50); do echo line $i; done" },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 50");
    expect(result.content).not.toContain("line 1\n");
    expect(result.content).toContain("Showing lines 46-50 of 50");

    const match = /Full output: (\S+?)\]/.exec(result.content);
    expect(match).not.toBeNull();
    const full = await readFile((match as RegExpExecArray)[1] as string, "utf8");
    expect(full).toContain("line 1\n");
    expect(full).toContain("line 50\n");
  });

  it("rejects arguments it does not understand", async () => {
    const cwd = await temporaryDirectory();
    const tool = new BashTool({ cwd });

    for (const value of [
      {},
      { command: "" },
      { command: "   " },
      { command: "echo hi", cwd: "/" },
      { command: "echo hi", timeout: "10" },
      "echo hi",
    ]) {
      const result = await tool.execute(value, { workspace: unusedWorkspace });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects a timeout that is not a positive number", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({ cwd }).execute(
      { command: "echo hi", timeout: 0 },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("positive number of seconds");
  });

  it("reports a missing working directory instead of throwing", async () => {
    const cwd = await temporaryDirectory();
    const missing = path.join(cwd, "gone");

    const result = await new BashTool({ cwd: missing }).execute(
      { command: "echo hi" },
      { workspace: unusedWorkspace },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not exist");
  });
  it("closes the spill file when the run is aborted", async () => {
    const cwd = await temporaryDirectory();
    const openDescriptors = (): number => {
      try {
        return readdirSync("/proc/self/fd").length;
      } catch {
        return -1;
      }
    };
    // Linux only: elsewhere there is nothing to count and the check is skipped.
    if (openDescriptors() < 0) {
      return;
    }

    const before = openDescriptors();
    for (let round = 0; round < 5; round += 1) {
      const controller = new AbortController();
      const execution = new BashTool({
        cwd,
        maxLines: 2,
        maxBytes: 100,
        tempDirectory: cwd,
      }).execute(
        { command: "for i in $(seq 1 200); do echo line $i; done; sleep 30" },
        { workspace: unusedWorkspace, signal: controller.signal },
      );
      await delay(150);
      controller.abort();
      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    }

    // Every aborted run spilled to a file; none of them may still hold it open.
    expect(openDescriptors()).toBeLessThanOrEqual(before + 2);
  });

  it("keeps the spill file readable only by its owner", async () => {
    const cwd = await temporaryDirectory();

    const result = await new BashTool({
      cwd,
      maxLines: 2,
      maxBytes: 10_000,
      tempDirectory: cwd,
    }).execute(
      { command: "for i in $(seq 1 20); do echo secret $i; done" },
      { workspace: unusedWorkspace },
    );

    const match = /Full output: (\S+?)\]/.exec(result.content);
    expect(match).not.toBeNull();
    const mode = statSync((match as RegExpExecArray)[1] as string).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
