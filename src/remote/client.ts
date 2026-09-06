import { createConnection, type Socket } from "node:net";
import type { AgentEvent, AgentEventListener } from "../events.js";
import { encodeMessage, FramingError, LineDecoder, parseLine } from "./framing.js";
import {
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerHello,
  type ServerResult,
} from "./protocol.js";

export class RemoteError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "RemoteError";
  }
}

export interface RemoteSessionOptions {
  readonly socketPath: string;
  /** Receives the server's event stream, so the existing renderers work as-is. */
  readonly onEvent?: AgentEventListener;
  readonly onError?: (code: string, message: string) => void;
}

/**
 * A client attached to a session running in another process.
 *
 * It holds no state of its own: it sends prompts and renders what comes back.
 * That is what keeps a second client honest — two attached clients see one
 * stream because there is only one session.
 */
export class RemoteSession {
  private socket: Socket | undefined;
  private readonly decoder = new LineDecoder();
  private hello: ServerHello | undefined;
  private pending: {
    resolve: (result: ServerResult) => void;
    reject: (error: Error) => void;
  } | undefined;
  private closedReason: string | undefined;

  constructor(private readonly options: RemoteSessionOptions) {}

  get session(): ServerHello["session"] {
    if (this.hello === undefined) {
      throw new RemoteError("Not connected.");
    }
    return this.hello.session;
  }

  get toolNames(): readonly string[] {
    return this.hello?.tools ?? [];
  }

  async connect(): Promise<ServerHello> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(this.options.socketPath);
      candidate.once("connect", () => {
        candidate.off("error", reject);
        resolve(candidate);
      });
      candidate.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new RemoteError(
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? `No chivgent server is listening on ${this.options.socketPath}.`
              : `Could not connect to ${this.options.socketPath}: ${error.message}`,
          ),
        );
      });
    });

    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());

    return new Promise<ServerHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RemoteError("The server did not answer the handshake."));
      }, 5_000);
      this.onHello = (hello) => {
        clearTimeout(timer);
        resolve(hello);
      };
      this.onHelloError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.write({ type: "hello", version: PROTOCOL_VERSION });
    });
  }

  private onHello: ((hello: ServerHello) => void) | undefined;
  private onHelloError: ((error: Error) => void) | undefined;

  /** Sends a prompt and resolves when the run it started finishes. */
  prompt(text: string): Promise<ServerResult> {
    if (this.socket === undefined) {
      return Promise.reject(new RemoteError("Not connected."));
    }
    if (this.pending !== undefined) {
      return Promise.reject(new RemoteError("A prompt is already in flight."));
    }
    return new Promise<ServerResult>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.write({ type: "prompt", text });
    });
  }

  interrupt(): void {
    if (this.socket !== undefined && !this.socket.destroyed) {
      this.write({ type: "interrupt" });
    }
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }

  private write(message: ClientMessage): void {
    this.socket?.write(encodeMessage(message));
  }

  private receive(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error: unknown) {
      const message =
        error instanceof FramingError ? error.message : "Framing error.";
      this.failAll(new RemoteError(message));
      return;
    }

    for (const line of lines) {
      const parsed = parseLine(line);
      if ("error" in parsed) {
        this.options.onError?.("bad_message", parsed.error);
        continue;
      }
      const message = parseServerMessage(parsed.value);
      if ("error" in message) {
        this.options.onError?.("bad_message", message.error);
        continue;
      }

      switch (message.message.type) {
        case "hello":
          this.hello = message.message;
          this.onHello?.(message.message);
          this.onHello = undefined;
          this.onHelloError = undefined;
          break;
        case "event":
          this.options.onEvent?.(message.message.event as AgentEvent);
          break;
        case "result": {
          const pending = this.pending;
          this.pending = undefined;
          pending?.resolve(message.message);
          break;
        }
        case "error": {
          const error = new RemoteError(
            message.message.message,
            message.message.code,
          );
          this.options.onError?.(message.message.code, message.message.message);
          if (this.onHelloError !== undefined) {
            this.onHelloError(error);
            this.onHello = undefined;
            this.onHelloError = undefined;
            break;
          }
          // A busy or agent error ends the prompt that caused it; the
          // connection itself stays usable.
          const pending = this.pending;
          this.pending = undefined;
          pending?.reject(error);
          break;
        }
        case "bye":
          this.closedReason = message.message.reason;
          break;
      }
    }
  }

  private handleClose(): void {
    this.socket = undefined;
    this.failAll(
      new RemoteError(
        this.closedReason === undefined
          ? "The chivgent server closed the connection."
          : `The chivgent server closed the connection: ${this.closedReason}`,
      ),
    );
  }

  private failAll(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.onHelloError?.(error);
    this.onHello = undefined;
    this.onHelloError = undefined;
  }
}
