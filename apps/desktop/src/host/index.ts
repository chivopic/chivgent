import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoAgent, VISIBLE_DEMO_TIMING } from "./demo-agent.js";
import { HostService } from "./service.js";
import type { HostToMain } from "../protocol/messages.js";

/**
 * utilityProcess entry. Electron exposes the parent as process.parentPort,
 * which is not a worker_threads port and is absent when the file is launched
 * by plain Node.
 */
interface UtilityParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (
  process as NodeJS.Process & { parentPort?: UtilityParentPort }
).parentPort;

if (port === undefined) {
  console.error("chivgent agent host must be started by the desktop main process.");
  process.exit(1);
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "chivgent-desktop-"));
const parentPid = process.ppid;

const service = new HostService({
  send: (message: HostToMain) => {
    port.postMessage(message);
  },
  createAgent: (onEvent) =>
    createDemoAgent({
      workspaceRoot,
      timing: VISIBLE_DEMO_TIMING,
      onEvent,
    }),
});

port.on("message", (event) => {
  service.handle(event.data);
});

// utilityProcess is not a shell sandbox, and a dead parent does not always
// reap it. Exit once the desktop process is gone so a crash cannot leave a run
// holding the demo workspace.
const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 2_000);
parentWatch.unref();

process.on("uncaughtException", (error) => {
  try {
    port.postMessage({
      type: "error",
      code: "host_crash",
      message: error.message,
    });
  } catch {
    // The parent port may already be closed.
  }
  process.exit(1);
});
