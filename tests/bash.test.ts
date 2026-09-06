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
});
