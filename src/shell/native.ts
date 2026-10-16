import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalShellOperations, safeShellEnvironment } from "./local.js";
import type { ShellConfig } from "./config.js";
import type { ShellExecOptions, ShellOperations } from "./types.js";
import { ShellUnavailableError } from "./types.js";

export interface NativeShellOptions {
  readonly allowWrites?: boolean;
  readonly allowNetwork?: boolean;
  readonly sandboxExecutable?: string;
  readonly temporaryDirectory?: string;
  readonly protectedPaths?: readonly string[];
}

/** Build a fail-closed macOS Seatbelt invocation. Host files remain readable. */
export function nativeShellConfig(cwd: string, options: NativeShellOptions = {}): ShellConfig {
  if (process.platform !== "darwin" && options.sandboxExecutable === undefined) {
    throw new ShellUnavailableError("The native Seatbelt shell backend is supported only on macOS.");
  }
  const workspace = realpathSync(cwd);
  if (options.temporaryDirectory === undefined) {
    throw new ShellUnavailableError("Native shell requires a private per-command temporary directory.");
  }
  const temp = realpathSync(options.temporaryDirectory);
  const quote = (value: string): string => JSON.stringify(value);
  const rules = [
    "(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)", "(allow file-read*)",
    "(allow file-write* (subpath \"/dev/null\"))",
    ...(options.allowWrites ? [`(allow file-write* (subpath ${quote(workspace)}))`] : [`(deny file-write* (subpath ${quote(workspace)}))`]),
    ...[".git", ".agents", ".codex", ".aws", ".ssh", ...(options.protectedPaths ?? [])].map((name) => `(deny file-write* (subpath ${quote(path.isAbsolute(name) ? name : `${workspace}/${name}`)}))`),
    `(allow file-write* (subpath ${quote(temp)}))`,
    ...(options.allowNetwork ? ["(allow network*)"] : []),
    "(allow sysctl-read)", "(allow mach-lookup (global-name \"com.apple.system.logger\"))",
  ].join(" ");
  return { shell: options.sandboxExecutable ?? "/usr/bin/sandbox-exec", args: ["-p", rules, "/bin/bash", "--noprofile", "--norc", "-c"] };
}

export function createNativeShellOperations(options: NativeShellOptions = {}): ShellOperations {
  const sandbox = options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
  if (process.platform === "darwin" && !sandbox.startsWith("/")) {
    throw new ShellUnavailableError("Native shell backend requires an explicit sandbox executable path.");
  }
  return {
    backend: `native (Seatbelt, network ${options.allowNetwork ? "enabled" : "denied"})`,
    async exec(command: string, cwd: string, execOptions: ShellExecOptions) {
      const deniedPaths = [".git", ".agents", ".codex", ".aws", ".ssh"];
      for (const name of deniedPaths) {
        const protectedPath = path.join(cwd, name);
        if (existsSync(protectedPath) && lstatSync(protectedPath).isSymbolicLink()) {
          throw new ShellUnavailableError(`Protected path is a symlink; refusing native shell: ${name}`);
        }
      }
      const canonicalWorkspace = realpathSync(cwd);
      const gitEntry = path.join(canonicalWorkspace, ".git");
      if (options.allowWrites && existsSync(gitEntry) && lstatSync(gitEntry).isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(gitEntry, "utf8"));
        if (match?.[1] === undefined) throw new ShellUnavailableError("Unrecognized .git pointer; refusing write-enabled native shell.");
        const gitDir = path.resolve(canonicalWorkspace, match[1]);
        let canonicalGitDir: string;
        try { canonicalGitDir = realpathSync(gitDir); } catch {
          throw new ShellUnavailableError("The .git pointer target cannot be resolved; refusing write-enabled native shell.");
        }
        if (canonicalGitDir === canonicalWorkspace || canonicalGitDir.startsWith(`${canonicalWorkspace}${path.sep}`)) deniedPaths.push(canonicalGitDir);
      }
      const temp = await mkdtemp(path.join(tmpdir(), "chivgent-shell-"));
      try {
        const env = { ...safeShellEnvironment(), HOME: temp, TMPDIR: temp };
        return await createLocalShellOperations({
          resolveConfig: (root) => nativeShellConfig(root, { ...options, protectedPaths: deniedPaths, temporaryDirectory: realpathSync(temp) }), env,
        }).exec(command, cwd, { ...execOptions, env });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}
