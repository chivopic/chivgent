import { DEFAULTS } from "../config/defaults.js";

export interface ClientOptions {
  readonly timeoutMs?: number;
}

export function createHttpClient(options: ClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  return {
    timeoutMs,
    async request(path: string) {
      return { path, timeoutMs };
    },
  };
}
