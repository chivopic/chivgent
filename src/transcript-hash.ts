import { createHash } from "node:crypto";
import type { Message } from "./messages.js";

/** Stable integrity marker for binding a compaction split point to a transcript. */
export function transcriptHash(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}
