import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { defaultSessionHome } from "../session-store.js";

const SOCKETS_DIRECTORY = "sockets";
const SUFFIX = ".sock";
const PROBE_TIMEOUT_MS = 500;

/**
 * A Unix socket address is a fixed-size field in the kernel: 108 bytes on
 * Linux, 104 on macOS. A longer path is not an error there — it is silently
 * truncated, which produces a socket nobody can find under the name they
 * expected. The limit is checked here so it fails loudly instead.
 */
const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

export class SocketPathTooLongError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `The socket path is ${Buffer.byteLength(socketPath, "utf8")} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit this platform allows:\n  ${socketPath}\nSet CHIVGENT_HOME to a shorter directory.`,
    );
    this.name = "SocketPathTooLongError";
  }
}

export function assertSocketPathFits(socketPath: string): void {
  if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new SocketPathTooLongError(socketPath);
  }
}

export function socketsDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(defaultSessionHome(environment), SOCKETS_DIRECTORY);
}

export function socketPathFor(
  id: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(socketsDirectory(environment), `${id}${SUFFIX}`);
}

/**
 * Creates the socket directory with owner-only permissions.
 *
 * The directory is the real gate. `net` cannot set a mode when it binds, so the
 * socket file briefly exists with default permissions; nobody can reach it
 * through a 0700 directory in the meantime.
 */
export async function ensureSocketsDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

/** True when something is listening on this socket right now. */
export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const settle = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * Clears a socket file left behind by a crashed server.
 *
 * Returns false when the socket answers, which means a live server owns this
 * id and the caller must not take it over.
 */
export async function clearStaleSocket(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath);
  } catch {
    return true;
  }
  if (await isSocketAlive(socketPath)) {
    return false;
  }
  await unlink(socketPath).catch(() => undefined);
  return true;
}

export interface ServerEntry {
  readonly id: string;
  readonly path: string;
}

/** Lists the servers that actually answer, removing sockets that do not. */
export async function listServers(
  directory: string = socketsDirectory(),
): Promise<readonly ServerEntry[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const alive: ServerEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SUFFIX)) {
      continue;
    }
    const socketPath = path.join(directory, name);
    if (await isSocketAlive(socketPath)) {
      alive.push({ id: name.slice(0, -SUFFIX.length), path: socketPath });
    } else {
      // Listing is also when stale files get cleaned up; nothing else walks
      // this directory.
      await unlink(socketPath).catch(() => undefined);
    }
  }
  return alive;
}

/** Accepts either a session id or an explicit socket path. */
export function resolveSocketTarget(
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return target.includes(path.sep) || target.endsWith(SUFFIX)
    ? path.resolve(target)
    : socketPathFor(target, environment);
}
