/** Tracks whether the current renderer completed its event-subscription handshake. */
export class RendererLifecycle {
  private alive = false;

  markReady(): void { this.alive = true; }
  markGone(): void { this.alive = false; }
  isAlive(): boolean { return this.alive; }
}
