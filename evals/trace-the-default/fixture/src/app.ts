import { createClient } from "./client.js";
import { PRODUCTION_TIMEOUT_MS, STAGING_TIMEOUT_MS } from "./env.js";

export function buildClient(environment: string) {
  if (environment === "production") {
    return createClient({ timeoutMs: PRODUCTION_TIMEOUT_MS });
  }
  if (environment === "staging") {
    return createClient({ timeoutMs: STAGING_TIMEOUT_MS });
  }
  // Local development leaves it to the client's own default.
  return createClient();
}
