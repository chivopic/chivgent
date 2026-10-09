import { realpathSync } from "node:fs";
import { createLocalShellOperations } from "./local.js";
import type { ShellConfig } from "./config.js";
import type { ShellOperations } from "./types.js";

/**
 * A deliberately constrained Docker invocation. The only host mount is the
 * working directory; no home, Docker socket, API credentials or host network
 * are made available to commands.
 */
export const DEFAULT_SHELL_IMAGE = "node:22-alpine";

export interface DockerShellOptions {
  readonly image?: string;
  readonly dockerExecutable?: string;
}

export function dockerShellConfig(cwd: string, options: DockerShellOptions = {}): ShellConfig {
  const workspace = realpathSync(cwd);
  const image = options.image ?? DEFAULT_SHELL_IMAGE;
  const docker = options.dockerExecutable ?? "docker";
  if (!image || image.startsWith("-")) {
    throw new TypeError("Invalid Docker image.");
  }
  const user = typeof process.getuid === "function"
    ? `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`
    : "1000:1000";

  return {
    shell: docker,
    args: [
      "run", "--rm", "--interactive",
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "64",
      "--memory", "512m",
      "--cpus", "2",
      "--user", user,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
      "--mount", `type=bind,source=${workspace},target=/workspace`,
      "--workdir", "/workspace",
      "--env", "HOME=/tmp",
      image, "sh", "-c",
    ],
  };
}

/**
 * Reuse the existing streaming, timeout and process-tree cancellation logic.
 * A missing Docker binary or daemon fails the command; there is never a host
 * shell fallback.
 */
export function createDockerShellOperations(options: DockerShellOptions = {}): ShellOperations {
  return createLocalShellOperations({
    resolveConfig: (cwd) => dockerShellConfig(cwd, options),
  });
}
