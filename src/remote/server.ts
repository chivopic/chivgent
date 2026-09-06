import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { AgentEvent } from "../events.js";
import type { AgentSession } from "../session.js";
import { encodeMessage, FramingError, LineDecoder, parseLine } from "./framing.js";
import {
  parseClientMessage,
  PROTOCOL_VERSION,
  summariseSession,
  type ProtocolErrorCode,
  type ServerMessage,
} from "./protocol.js";
import {
  assertSocketPathFits,
  clearStaleSocket,
  ensureSocketsDirectory,
} from "./socket-path.js";

export class SocketInUseError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `Another chivgent server is already listening on ${socketPath}. Stop it, or serve a different session.`,
    );
    this.name = "SocketInUseError";
  }
}

export interface SessionServerOptions {
  readonly session: AgentSession;
  readonly socketPath: string;
  /** Named in the handshake so an attaching client can see what it gets. */
  readonly capabilities: readonly string[];
  readonly onWarning?: (message: string) => void;
}

interface Connection {
  readonly socket: Socket;
  readonly decoder: LineDecoder;
  greeted: boolean;
}

/**
 * Exposes one session on a Unix socket.
 *
 * A client is just another subscriber that lives in another process, which is
 * why this is thin: the session already fans events out and already runs one
 * prompt at a time.
 */
export class SessionServer {
  private readonly connections = new Set<Connection>();
  private server: Server | undefined;
  private running = false;
  private controller: AbortController | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: SessionServerOptions) {}

  get socketPath(): string {
    return this.options.socketPath;
  }

  async listen(): Promise<void> {
    // Checked before binding: an over-long path binds "successfully" to a
    // truncated name, and every later lookup then misses.
    assertSocketPathFits(this.options.socketPath);
    await ensureSocketsDirectory(path.dirname(this.options.socketPath));
    if (!(await clearStaleSocket(this.options.socketPath))) {
      throw new SocketInUseError(this.options.socketPath);
    }

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Defence in depth behind the 0700 directory. A failure here is reported
    // rather than swallowed: silence once hid a socket bound to a truncated
    // path, where the chmod was failing on a name that did not exist.
    await chmod(this.options.socketPath, 0o600).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onWarning?.(
        `could not restrict the socket permissions: ${message}`,
      );
    });

    server.on("error", (error) => {
      this.options.onWarning?.(`socket error: ${error.message}`);
    });
    this.unsubscribe = this.options.session.subscribe((event) =>
      this.broadcast({ type: "event", event }),
    );
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const connection of this.connections) {
      this.send(connection, { type: "bye", reason: "server shutting down" });
      connection.socket.end();
    }
    this.connections.clear();

    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.options.socketPath).catch(() => undefined);
  }

  private accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      decoder: new LineDecoder(),
      greeted: false,
    };
    this.connections.add(connection);
    socket.setNoDelay(true);

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = connection.decoder.push(chunk);
      } catch (error: unknown) {
        const message =
          error instanceof FramingError ? error.message : "Framing error.";
        this.fail(connection, "too_large", message);
        return;
      }
      for (const line of lines) {
        this.handleLine(connection, line);
      }
    });

    // A client going away is ordinary: it removes a subscriber and nothing
    // else. The run in flight belongs to the session, not to the connection.
    socket.on("error", () => this.drop(connection));
    socket.on("close", () => this.drop(connection));
  }

  private drop(connection: Connection): void {
    this.connections.delete(connection);
    connection.socket.destroy();
  }

  private handleLine(connection: Connection, line: string): void {
    const parsed = parseLine(line);
    if ("error" in parsed) {
      this.fail(connection, "bad_message", parsed.error);
      return;
    }
    const message = parseClientMessage(parsed.value);
    if ("error" in message) {
      this.fail(connection, "bad_message", message.error);
      return;
    }

    switch (message.message.type) {
      case "hello": {
        if (message.message.version !== PROTOCOL_VERSION) {
          this.fail(
            connection,
            "version_mismatch",
            `This server speaks protocol ${PROTOCOL_VERSION}; the client speaks ${message.message.version}.`,
          );
          return;
        }
        connection.greeted = true;
        this.send(connection, {
          type: "hello",
          version: PROTOCOL_VERSION,
          session: summariseSession({
            id: this.options.session.id,
            cwd: this.options.session.cwd,
            turns: this.options.session.turns,
            messages: this.options.session.messages,
            capabilities: this.options.capabilities,
          }),
          tools: this.options.session.toolNames,
        });
        return;
      }
      case "prompt": {
        if (!connection.greeted) {
          this.fail(connection, "bad_message", "Send hello before prompting.");
          return;
        }
        void this.runPrompt(connection, message.message.text);
        return;
      }
      case "interrupt": {
        // Any connection may interrupt: the run belongs to the session, the
        // same way a local Ctrl+C is not owned by whoever typed the prompt.
        this.controller?.abort();
        return;
      }
    }
  }

  private async runPrompt(connection: Connection, text: string): Promise<void> {
    if (this.running) {
      this.send(connection, {
        type: "error",
        code: "busy",
        message: "This session is already answering. Try again when it finishes.",
      });
      return;
    }

    this.running = true;
    this.controller = new AbortController();
    try {
      const result = await this.options.session.prompt(text, {
        signal: this.controller.signal,
      });
      this.broadcast({
        type: "result",
        status: result.status,
        messages: result.messages.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.broadcast({ type: "error", code: "agent_error", message });
      this.broadcast({ type: "result", status: "error", messages: 0 });
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }

  private fail(
    connection: Connection,
    code: ProtocolErrorCode,
    message: string,
  ): void {
    this.send(connection, { type: "error", code, message });
    this.send(connection, { type: "bye", reason: code });
    connection.socket.end();
    this.connections.delete(connection);
  }

  private broadcast(message: ServerMessage): void {
    for (const connection of [...this.connections]) {
      this.send(connection, message);
    }
  }

  private send(connection: Connection, message: ServerMessage): void {
    if (connection.socket.destroyed) {
      return;
    }
    try {
      connection.socket.write(encodeMessage(message));
    } catch {
      // A write that fails means the peer is gone; dropping it here keeps a
      // broken client from turning into a failed run.
      this.drop(connection);
    }
  }
}

export type { AgentEvent };
