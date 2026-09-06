import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSession } from "../src/remote/client.js";
import { FramingError, LineDecoder, encodeMessage, parseLine } from "../src/remote/framing.js";
import { PROTOCOL_VERSION, parseClientMessage, parseServerMessage } from "../src/remote/protocol.js";
import { SessionServer, SocketInUseError } from "../src/remote/server.js";
import {
  SocketPathTooLongError,
  assertSocketPathFits,
  clearStaleSocket,
  listServers,
  resolveSocketTarget,
} from "../src/remote/socket-path.js";
import { AgentSession } from "../src/session.js";
import type { AgentEvent } from "../src/events.js";
import { FakeLLMClient, assistant, readOnlyWorkspaceWrites } from "./fakes.js";
import type { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];
const servers: SessionServer[] = [];
const clients: RemoteSession[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-remote-"));
  temporaryDirectories.push(directory);
  return directory;
}

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

/**
 * A Provider the test can hold open, so a run is genuinely still in flight
 * while a second prompt arrives.
 */
class GatedLLMClient extends FakeLLMClient {
  private release: (() => void) | undefined;
  private announceStart: (() => void) | undefined;
  readonly started: Promise<void>;

  constructor(responses: readonly ReturnType<typeof assistant>[]) {
    super(responses);
    // Built in the constructor: a field initialiser assigning to a field
    // declared later would be undone by that field's own initialisation.
    this.started = new Promise<void>((resolve) => {
      this.announceStart = resolve;
    });
  }

  override async complete(request: Parameters<FakeLLMClient["complete"]>[0]) {
    this.announceStart?.();
    // A real Provider rejects an in-flight call when the signal fires, so the
    // fake does too; otherwise nothing here would ever exercise cancellation.
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      const signal = request.signal;
      if (signal !== undefined) {
        const onAbort = (): void => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
    return super.complete(request);
  }

  finish(): void {
    this.release?.();
  }
}

/** Polls until the condition holds, so a test never sleeps a fixed guess. */
function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for a condition"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

/** Resolves once the listener has seen an event of this type. */
function waitForEvent(
  events: readonly AgentEvent[],
  type: AgentEvent["type"],
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (events.some((event) => event.type === type)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${type}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function createSession(responses = [assistant("done")]): AgentSession {
  return new AgentSession({
    agent: {
      systemPrompt: "system",
      maxTurns: 4,
      llm: new FakeLLMClient(responses),
      tools: [],
      workspace,
    },
    cwd: "/workspace",
  });
}

async function serve(
  session: AgentSession,
  directory: string,
  capabilities: readonly string[] = [],
): Promise<SessionServer> {
  const server = new SessionServer({
    session,
    socketPath: path.join(directory, `${session.id}.sock`),
    capabilities,
  });
  await server.listen();
  servers.push(server);
  return server;
}

async function attach(
  socketPath: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<RemoteSession> {
  const remote = new RemoteSession({
    socketPath,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
  await remote.connect();
  clients.push(remote);
  return remote;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LineDecoder", () => {
  it("reassembles a message split across chunks", () => {
    const decoder = new LineDecoder();
    const line = encodeMessage({ type: "interrupt" });

    expect(decoder.push(Buffer.from(line.slice(0, 5)))).toEqual([]);
    expect(decoder.push(Buffer.from(line.slice(5)))).toEqual([line.trim()]);
  });

  it("splits several messages arriving in one chunk", () => {
    const decoder = new LineDecoder();
    const chunk = `${encodeMessage({ a: 1 })}${encodeMessage({ b: 2 })}`;

    expect(decoder.push(Buffer.from(chunk))).toHaveLength(2);
  });

  it("ignores blank lines", () => {
    expect(new LineDecoder().push(Buffer.from("\n\n"))).toEqual([]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from(`{"t":"\u6211"}\n`, "utf8");

    decoder.push(bytes.subarray(0, 9));
    const lines = decoder.push(bytes.subarray(9));

    expect(JSON.parse(lines[0] as string)).toEqual({ t: "\u6211" });
  });

  it("refuses a line that never ends instead of buffering forever", () => {
    const decoder = new LineDecoder(64);

    expect(() => decoder.push(Buffer.from("x".repeat(200)))).toThrow(FramingError);
  });
});

describe("protocol validation", () => {
  it("accepts the three client messages", () => {
    expect(parseClientMessage({ type: "hello", version: 1 })).toHaveProperty("message");
    expect(parseClientMessage({ type: "prompt", text: "hi" })).toHaveProperty("message");
    expect(parseClientMessage({ type: "interrupt" })).toHaveProperty("message");
  });

  it("rejects malformed client messages", () => {
    for (const value of [
      null,
      [],
      "hello",
      { type: "hello" },
      { type: "hello", version: "1" },
      { type: "prompt" },
      { type: "prompt", text: "  " },
      { type: "nonsense" },
    ]) {
      expect(parseClientMessage(value)).toHaveProperty("error");
    }
  });

  it("rejects malformed server messages", () => {
    for (const value of [
      { type: "hello", version: 1 },
      { type: "error", code: "busy" },
      { type: "event" },
      { type: "event", event: {} },
    ]) {
      expect(parseServerMessage(value)).toHaveProperty("error");
    }
  });

  it("reports invalid JSON rather than throwing", () => {
    expect(parseLine("{ not json")).toHaveProperty("error");
  });
});

describe("socket paths", () => {
  it("accepts an id or an explicit path", () => {
    expect(resolveSocketTarget("/tmp/x/y.sock")).toBe("/tmp/x/y.sock");
    expect(resolveSocketTarget("abc", { CHIVGENT_HOME: "/home/x" })).toBe(
      "/home/x/sockets/abc.sock",
    );
  });

  it("refuses a path longer than the kernel's socket address field", () => {
    // Over-long paths are truncated rather than rejected by the OS, which
    // binds a socket under a name nothing will look for.
    const long = `/tmp/${"d".repeat(120)}/x.sock`;

    expect(() => assertSocketPathFits(long)).toThrow(SocketPathTooLongError);
    expect(() => assertSocketPathFits(long)).toThrow(/CHIVGENT_HOME/);
    expect(() => assertSocketPathFits("/tmp/short.sock")).not.toThrow();
  });

  it("clears a socket file nothing is listening on", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "dead.sock");
    await writeFile(socketPath, "");

    expect(await clearStaleSocket(socketPath)).toBe(true);
    await expect(stat(socketPath)).rejects.toBeDefined();
  });

  it("refuses to take over a socket that answers", async () => {
    const directory = await temporaryDirectory();
    const socketPath = path.join(directory, "alive.sock");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve));

    try {
      expect(await clearStaleSocket(socketPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("lists live servers and removes dead sockets", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "dead.sock"), "");
    const session = createSession();
    const server = await serve(session, directory);

    const found = await listServers(directory);

    expect(found.map((entry) => entry.path)).toEqual([server.socketPath]);
    await expect(stat(path.join(directory, "dead.sock"))).rejects.toBeDefined();
  });
});

describe("SessionServer", () => {
  it("hands the client a session summary and the tool names", async () => {
    const directory = await temporaryDirectory();
    const session = createSession();
    const server = await serve(session, directory, ["--allow-shell"]);

    const remote = await attach(server.socketPath);

    expect(remote.session.id).toBe(session.id);
    expect(remote.session.cwd).toBe("/workspace");
    expect(remote.session.capabilities).toEqual(["--allow-shell"]);
  });

  it("creates the socket owner-only inside an owner-only directory", async () => {
    const home = await temporaryDirectory();
    const directory = path.join(home, "sockets");
    const server = await serve(createSession(), directory);

    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    // The directory is the real gate: net cannot set a mode when it binds, so
    // the socket file exists briefly with default permissions.
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("removes the socket file when it closes", async () => {
    const directory = await temporaryDirectory();
    const server = await serve(createSession(), directory);
    const socketPath = server.socketPath;

    await server.close();
    servers.splice(servers.indexOf(server), 1);

    await expect(stat(socketPath)).rejects.toBeDefined();
  });

  it("refuses to bind over a live server", async () => {
    const directory = await temporaryDirectory();
    const session = createSession();
    const first = await serve(session, directory);

    const second = new SessionServer({
      session,
      socketPath: first.socketPath,
      capabilities: [],
    });

    await expect(second.listen()).rejects.toBeInstanceOf(SocketInUseError);
  });

  it("streams a run's events to the client and reports the result", async () => {
    const directory = await temporaryDirectory();
    const server = await serve(createSession(), directory);
    const events: AgentEvent[] = [];
    const remote = await attach(server.socketPath, (event) => events.push(event));

    const result = await remote.prompt("hello");

    expect(result.status).toBe("completed");
    expect(events[0]?.type).toBe("agent_start");
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("gives every attached client the same stream", async () => {
    const directory = await temporaryDirectory();
    const server = await serve(createSession(), directory);
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];
    const driver = await attach(server.socketPath, (event) => first.push(event));
    await attach(server.socketPath, (event) => second.push(event));

    await driver.prompt("hello");
    // The observer's socket delivers independently of the driver's, so the
    // prompt resolving says nothing about what the second client has received.
    await waitForEvent(second, "agent_end");

    expect(second.map((event) => event.type)).toEqual(first.map((event) => event.type));
    expect(second[0]?.type).toBe("agent_start");
    expect(second.at(-1)?.type).toBe("agent_end");
  });

  it("refuses a second prompt while one is running, without disturbing it", async () => {
    const directory = await temporaryDirectory();
    const llm = new GatedLLMClient([assistant("first")]);
    const session = new AgentSession({
      agent: { systemPrompt: "system", maxTurns: 4, llm, tools: [], workspace },
      cwd: "/workspace",
    });
    const server = await serve(session, directory);
    const driver = await attach(server.socketPath);
    const other = await attach(server.socketPath);

    const inFlight = driver.prompt("one");
    await llm.started;

    await expect(other.prompt("two")).rejects.toMatchObject({ code: "busy" });

    // The run that was already going still finishes normally.
    llm.finish();
    expect((await inFlight).status).toBe("completed");
  });

  it("rejects a prompt sent before hello", async () => {
    const directory = await temporaryDirectory();
    const server = await serve(createSession(), directory);
    const { createConnection } = await import("node:net");
    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.write(encodeMessage({ type: "prompt", text: "hi" }));
    });
    socket.destroy();

    expect(JSON.parse(reply.split("\n")[0] as string)).toMatchObject({
      type: "error",
      code: "bad_message",
    });
  });

  it("refuses a client speaking another protocol version", async () => {
    const directory = await temporaryDirectory();
    const server = await serve(createSession(), directory);
    const { createConnection } = await import("node:net");
    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket.write(encodeMessage({ type: "hello", version: PROTOCOL_VERSION + 1 }));
    });
    socket.destroy();

    const parsed = JSON.parse(reply.split("\n")[0] as string);
    expect(parsed).toMatchObject({ type: "error", code: "version_mismatch" });
    // Both versions are named, so the mismatch is diagnosable from one message.
    expect(parsed.message).toContain(String(PROTOCOL_VERSION));
    expect(parsed.message).toContain(String(PROTOCOL_VERSION + 1));
  });

  it("lets any connection interrupt the run", async () => {
    const directory = await temporaryDirectory();
    const llm = new GatedLLMClient([assistant("never delivered")]);
    const session = new AgentSession({
      agent: { systemPrompt: "system", maxTurns: 4, llm, tools: [], workspace },
      cwd: "/workspace",
    });
    const server = await serve(session, directory);
    const driver = await attach(server.socketPath);
    const bystander = await attach(server.socketPath);

    const inFlight = driver.prompt("one");
    await llm.started;

    // The run belongs to the session, not to whoever started it. The abort
    // is what releases the gated call, so nothing else has to finish it.
    bystander.interrupt();

    expect((await inFlight).status).toBe("aborted");
  });

  it("finishes a run whose client disconnected halfway", async () => {
    const directory = await temporaryDirectory();
    const llm = new GatedLLMClient([assistant("finished anyway")]);
    const session = new AgentSession({
      agent: { systemPrompt: "system", maxTurns: 4, llm, tools: [], workspace },
      cwd: "/workspace",
    });
    const server = await serve(session, directory);
    const remote = await attach(server.socketPath);

    void remote.prompt("hello").catch(() => undefined);
    // Wait until the run is genuinely in flight, then drop the connection: a
    // client going away must not cancel work the session already started.
    await llm.started;
    remote.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    llm.finish();
    // turns counts prompts and rises before the run; the transcript is only
    // replaced once it finishes, so that is what proves the run completed.
    await waitFor(() => session.messages.length > 0);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "finished anyway",
    });
  });
});
