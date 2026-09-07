/** Entries older than this are evicted. Unrelated to the HTTP client. */
export const CACHE_TTL_MS = 45000;

export class Cache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined || Date.now() - entry.at > CACHE_TTL_MS) {
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, at: Date.now() });
  }
}
