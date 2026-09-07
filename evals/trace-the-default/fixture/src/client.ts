import { DEFAULTS } from "./defaults.js";

export interface ClientOptions {
  readonly timeoutMs?: number;
}

export function createClient(options: ClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  return {
    timeoutMs,
    async request(path: string) {
      return { path, timeoutMs };
    },
  };
}
