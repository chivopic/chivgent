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
  /** Maximum bytes buffered for one remote client. Defaults to 4 MiB. */
  readonly maxPendingBytes?: number;
}

export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

interface Connection {
  readonly socket: Socket;
  readonly decoder: LineDecoder;
  greeted: boolean;
  closed: boolean;
  ending: boolean;
  detachInput: () => void;
  detachTerminal: () => void;
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

  private readonly options: SessionServerOptions;

  constructor(options: SessionServerOptions) {
    if (options.maxPendingBytes !== undefined &&
      (!Number.isSafeInteger(options.maxPendingBytes) || options.maxPendingBytes <= 0)) {
      throw new RangeError("maxPendingBytes must be a positive safe integer.");
    }
    this.options = options;
  }

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
    for (const connection of [...this.connections]) {
      if (!connection.ending) {
        this.send(connection, { type: "bye", reason: "server shutting down" });
        connection.ending = true;
        connection.socket.end();
      }
      // A peer that stopped reading can keep end() buffered indefinitely.
      // The final frame is best effort; destroying the socket lets close drain.
      this.drop(connection);
    }

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
      closed: false,
      ending: false,
      detachInput: () => undefined,
      detachTerminal: () => undefined,
    };
    this.connections.add(connection);
    socket.setNoDelay(true);

    const onData = (chunk: Buffer): void => {
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
    };

    // A client going away is ordinary: it removes a subscriber and nothing
    // else. The run in flight belongs to the session, not to the connection.
    const onError = (): void => this.drop(connection);
    const onClose = (): void => {
      if (!connection.closed) {
        this.drop(connection);
      }
      connection.detachTerminal();
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    connection.detachInput = () => {
      socket.off("data", onData);
    };
    connection.detachTerminal = () => {
      socket.off("error", onError);
      socket.off("close", onClose);
    };
  }

  private drop(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    this.connections.delete(connection);
    connection.detachInput();
    // Keep the error listener until close: a pending write may report its
    // failure asynchronously after destroy() has been requested.
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
    connection.ending = true;
    connection.socket.end();
  }

  private broadcast(message: ServerMessage): void {
    let encoded: string;
    try {
      encoded = encodeMessage(message);
    } catch (error: unknown) {
      this.warn("encode", error);
      for (const connection of [...this.connections]) {
        this.drop(connection);
      }
      return;
    }
    for (const connection of [...this.connections]) {
      this.write(connection, encoded);
    }
  }

  private send(connection: Connection, message: ServerMessage): void {
    let encoded: string;
    try {
      encoded = encodeMessage(message);
    } catch (error: unknown) {
      this.warn("encode", error);
      this.drop(connection);
      return;
    }
    this.write(connection, encoded);
  }

  private write(connection: Connection, encoded: string): void {
    const { socket } = connection;
    if (connection.closed || connection.ending || socket.destroyed) {
      return;
    }
    const frameBytes = Buffer.byteLength(encoded, "utf8");
    const maxPendingBytes = this.options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    const pendingBytes = socket.writableLength;
    // A single frame larger than the budget is not queued; disconnecting
    // avoids silently losing part of an event stream and pretending it is whole.
    if (frameBytes > maxPendingBytes || pendingBytes + frameBytes > maxPendingBytes) {
      this.options.onWarning?.(
        `remote client exceeded the ${maxPendingBytes}-byte pending-send budget (pending ${pendingBytes} bytes, next frame ${frameBytes} bytes); disconnecting that client`,
      );
      this.drop(connection);
      return;
    }
    try {
      // `writableLength` accounts for bytes accepted by the socket but not
      // flushed. There is no separate application-side send queue.
      socket.write(encoded);
    } catch (error: unknown) {
      this.warn("write", error);
      this.drop(connection);
    }
  }

  private warn(kind: "encode" | "write", error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.options.onWarning?.(`remote ${kind} failure: ${detail}`);
  }
}

export type { AgentEvent };
