import { createHttpClient } from "./http/client.js";
import {
  DEVELOPMENT_TIMEOUT_MS,
  PRODUCTION_TIMEOUT_MS,
  STAGING_TIMEOUT_MS,
} from "./config/environments.js";

export function buildHttpClient(environment: string) {
  if (environment === "production") {
    return createHttpClient({ timeoutMs: PRODUCTION_TIMEOUT_MS });
  }
  if (environment === "staging") {
    return createHttpClient({ timeoutMs: STAGING_TIMEOUT_MS });
  }
  return createHttpClient({ timeoutMs: DEVELOPMENT_TIMEOUT_MS });
}
