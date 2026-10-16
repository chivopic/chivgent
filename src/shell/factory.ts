import { createDockerShellOperations } from "./docker.js";
import { createNativeShellOperations } from "./native.js";
import type { ShellOperations } from "./types.js";
import { ShellUnavailableError } from "./types.js";

export type ShellBackend = "auto" | "native" | "docker";
export function createShellOperations(options: { backend?: ShellBackend; allowWrites?: boolean; allowNetwork?: boolean; allowHostAccess?: boolean } = {}): ShellOperations {
  const backend = options.backend ?? "auto";
  if (backend === "native" || (backend === "auto" && process.platform === "darwin")) {
    return createNativeShellOperations({ allowWrites: options.allowWrites, allowNetwork: options.allowNetwork, allowHostAccess: options.allowHostAccess });
  }
  if (options.allowHostAccess) throw new ShellUnavailableError("Host access is unavailable in the Docker shell backend; no command was run.");
  return createDockerShellOperations({ allowWrites: options.allowWrites, allowNetwork: options.allowNetwork });
}
