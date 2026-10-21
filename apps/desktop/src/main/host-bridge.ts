import { writeFileSync } from "node:fs";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  isHostToMain,
  type HostStatus,
  type HostToMain,
  type MainToHost,
} from "../protocol/messages.js";
import { hostEntryError, hostEntryPath } from "./paths.js";

const HOST_SERVICE_NAME = "chivgent-agent-host";
const REQUEST_TIMEOUT_MS = 8_000;
const HOST_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface HostBridge {
  readonly start: () => HostStatus;
  readonly request: (message: MainToHost) => Promise<HostToMain>;
  readonly onEvent: (listener: (message: HostToMain) => void) => () => void;
  readonly onStatus: (listener: (status: HostStatus) => void) => () => void;
  readonly shutdown: () => Promise<void>;
}

export function createHostBridge(): HostBridge {
  let child: UtilityProcess | undefined;
  let spawned: Promise<void> = Promise.resolve();
  let status: HostStatus = { phase: "starting" };
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const eventListeners = new Set<(message: HostToMain) => void>();
  const statusListeners = new Set<(status: HostStatus) => void>();
  const pending = new Map<
    string,
    { resolve: (message: HostToMain) => void; reject: (error: Error) => void }
  >();

  function publish(next: HostStatus): void {
    status = next;
    for (const listener of statusListeners) {
      listener(next);
    }
  }

  function failPending(message: string): void {
    for (const [requestId, waiter] of pending) {
      pending.delete(requestId);
      waiter.reject(new Error(message));
    }
  }

  function spawn(): HostStatus {
    if (child !== undefined) {
      return status;
    }
    const missing = hostEntryError();
    if (missing !== undefined) {
      publish({ phase: "failed", message: missing });
      return status;
    }
    publish({ phase: "starting", message: "正在启动 Agent host。" });
    const entry = hostEntryPath();
    const cwd = process.env["CHIVGENT_DESKTOP_HOST_CWD"];
    try {
      child = utilityProcess.fork(entry, [], {
        serviceName: HOST_SERVICE_NAME,
        stdio: "pipe",
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch (error: unknown) {
      publish({
        phase: "failed",
        message: error instanceof Error ? error.message : "Agent host 无法启动。",
      });
      return status;
    }
    const started = child;
    spawned = new Promise((resolve, reject) => {
      started.once("spawn", () => resolve());
      started.once("exit", (code) => {
        reject(new Error(`Agent host 在就绪前退出（${code ?? "unknown"}）。`));
      });
    });
    const pidFile = process.env["CHIVGENT_DESKTOP_HOST_PID_FILE"];
    started.on("spawn", () => {
      if (pidFile !== undefined && started.pid !== undefined) {
        try {
          writeFileSync(pidFile, String(started.pid));
        } catch {
          // A verification hook must not take down the app.
        }
      }
    });
    let stderr = "";
    started.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    started.stdout?.on("data", () => {
      // Drain so a piped host cannot block on a full buffer.
    });
    started.on("message", (message: unknown) => {
      if (!isHostToMain(message)) {
        publish({
          phase: status.phase === "ready" ? "ready" : status.phase,
          ...(status.hostInstanceId === undefined
            ? {}
            : { hostInstanceId: status.hostInstanceId }),
          message: "Agent host 发来了无法识别的消息。",
        });
        return;
      }
      if (message.type === "initialized") {
        publish({ phase: "ready", hostInstanceId: message.hostInstanceId });
      }
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId !== undefined && pending.has(requestId) && message.type !== "event") {
        const waiter = pending.get(requestId);
        pending.delete(requestId);
        waiter?.resolve(message);
      }
      for (const listener of eventListeners) {
        listener(message);
      }
    });
    started.on("exit", (code) => {
      child = undefined;
      const detail = stderr.trim();
      const message = shuttingDown
        ? "Agent host 已停止。"
        : detail.length > 0
          ? `Agent host 已退出（${code ?? "unknown"}）。${detail}`
          : `Agent host 已退出（${code ?? "unknown"}）。进行中的运行结果未知。`;
      publish({
        phase: shuttingDown ? "exited" : "exited",
        exitCode: code,
        message,
      });
      failPending(message);
    });
    return status;
  }

  return {
    start: spawn,
    async request(message) {
      spawn();
      if (status.phase === "failed" || child === undefined) {
        return Promise.reject(new Error(status.message ?? "Agent host 没有运行。"));
      }
      const target = child;
      try {
        await spawned;
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error("Agent host 没有就绪。"));
      }
      if (child !== target) {
        return Promise.reject(new Error(status.message ?? "Agent host 已退出。"));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.requestId);
          reject(new Error("Agent host 没有在时限内回应。"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(message.requestId, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          target.postMessage(message);
        } catch (error: unknown) {
          clearTimeout(timer);
          pending.delete(message.requestId);
          reject(error instanceof Error ? error : new Error("无法向 Agent host 发送请求。"));
        }
      });
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    shutdown() {
      if (shutdownPromise !== undefined) return shutdownPromise;
      shuttingDown = true;
      const target = child;
      if (target === undefined) {
        publish({ phase: "exited", message: "Agent host 已停止。" });
        shutdownPromise = Promise.resolve();
        return shutdownPromise;
      }

      // Register before sending the request: UtilityProcess can exit before
      // postMessage returns, and every forced-stop path must wait for this
      // owned process's actual exit event before Electron quits.
      let didExit = child !== target;
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      if (didExit) resolveExit();
      else target.once("exit", () => {
        didExit = true;
        resolveExit();
      });

      shutdownPromise = (async () => {
        let messageError: unknown;
        let messageFailed = false;
        try {
          target.postMessage({ type: "shutdown", requestId: "shutdown" });
        } catch (error: unknown) {
          messageFailed = true;
          messageError = error;
        }

        let gracefulExit = didExit;
        if (!messageFailed && !gracefulExit) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          gracefulExit = await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), HOST_SHUTDOWN_TIMEOUT_MS);
            }),
          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        }
        if (gracefulExit) return;

        let killError: unknown;
        let killResult: boolean | undefined;
        try {
          killResult = target.kill();
        } catch (error: unknown) {
          killError = error;
        }

        let killedExit = didExit;
        if (!killedExit) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          killedExit = await Promise.race([
            exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), HOST_SHUTDOWN_TIMEOUT_MS);
            }),
          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        }
        if (killedExit) return;
        throw new Error(`Agent host did not exit within ${HOST_SHUTDOWN_TIMEOUT_MS}ms after kill (PID ${target.pid}, kill returned ${String(killResult)}, kill error ${String(killError ?? "none")}, shutdown message error ${String(messageError ?? "none")}).`);
      })();
      return shutdownPromise;
    },
  };
}
