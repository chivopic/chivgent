/** How long an idle socket is kept before it is closed. */
export const SOCKET_IDLE_TIMEOUT_MS = 90000;

export function shouldClose(idleForMs: number): boolean {
  return idleForMs > SOCKET_IDLE_TIMEOUT_MS;
}
