import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";

const execFileAsync = promisify(execFile);
const MANUAL_UPDATE = "npm install -g chivgent@latest";
const HELP = `Usage: chivgent update [--check]

Update an npm global installation to the latest published version.
  --check      Check versions without installing
  -h, --help   Show this help

Source checkouts, local dependencies and npx runs receive manual instructions.
To send the word update as a question, use: chivgent -- update
`;

type NpmRunner = (args: readonly string[], timeout: number) => Promise<string>;

/** No shell interpolation; on Windows invoke npm's JS entry point directly. */
const runNpm: NpmRunner = async (args, timeout) => {
  const windows = process.platform === "win32";
  const command = windows ? process.execPath : "npm";
  const argv = windows
    ? [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args]
    : [...args];
  const pending = execFileAsync(command, argv, {
    cwd: homedir(), encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  pending.child.stdin?.end();
  return (await pending).stdout;
};

export interface UpdateOptions {
  readonly version: string;
  readonly packageRoot?: string;
  readonly nodeVersion?: string;
  readonly npm?: NpmRunner;
  readonly write?: (text: string) => void;
  readonly error?: (text: string) => void;
}

function installationHint(root: string): string {
  const parts = root.split(sep);
  if (parts.includes("_npx")) {
    return "This is a temporary npx installation. Start the latest version with: npx chivgent@latest";
  }
  if (parts.includes("node_modules")) {
    return "This is not the active npm global installation. For a project dependency, run npm install chivgent@latest in that project; for another package manager, use its update command.";
  }
  return "This is a source checkout or linked installation. In your checkout, run git pull --ff-only, npm ci, then npm run build. If needed, install it again with npm install -g .";
}

function absolutePath(output: string): string {
  const value = output.trim();
  if (!isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error("npm returned an invalid installation path.");
  }
  return value;
}

function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown error";
  // Registry and subprocess output must not execute terminal controls.
  return detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500);
}

/** Runs before provider configuration, session creation or project extensions. */
export async function runUpdate(argv: readonly string[], options: UpdateOptions): Promise<number> {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const error = options.error ?? ((text: string) => { process.stderr.write(text); });
  const npm = options.npm ?? runNpm;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    write(HELP);
    return 0;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check")) {
    error(HELP);
    return 1;
  }
  const checkOnly = argv[0] === "--check";
  write(`Current version: ${options.version}\n`);
  let phase = "check for updates";
  try {
    const root = await realpath(options.packageRoot ?? fileURLToPath(new URL("..", import.meta.url)));
    // Source and npx use cases need no npm executable or registry request.
    if (!root.split(sep).includes("node_modules") || root.split(sep).includes("_npx")) {
      write(`${installationHint(root)}\n`);
      return 0;
    }
    const prefix = absolutePath(await npm(["prefix", "--global"], 15_000));
    const globalRoot = absolutePath(await npm(["root", "--global", "--prefix", prefix], 15_000));
    const target = join(globalRoot, "chivgent");
    let globalInstallation = false;
    try {
      // npm link and other package-manager symlinks must not be replaced.
      globalInstallation = !(await lstat(target)).isSymbolicLink() && await realpath(target) === root;
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (!globalInstallation) {
      write(`${installationHint(root)}\n`);
      return 0;
    }

    write("Checking npm for the latest version…\n");
    const metadata: unknown = JSON.parse(await npm([
      "view", "chivgent@latest", "version", "engines", "--json", "--global", "--prefer-online",
    ], 30_000));
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata)
      || typeof metadata.version !== "string" || semver.valid(metadata.version) !== metadata.version) {
      throw new Error("npm returned invalid version metadata.");
    }
    const latest = metadata.version;
    if (semver.valid(options.version) === null) throw new Error("Cannot compare the current version.");
    write(`Latest version: ${latest}\n`);
    if (!semver.gt(latest, options.version)) {
      write(semver.eq(latest, options.version)
        ? "Already up to date.\n" : "Your version is newer than npm latest; no downgrade performed.\n");
      return 0;
    }
    if ("engines" in metadata && typeof metadata.engines === "object" && metadata.engines !== null
      && "node" in metadata.engines) {
      const required = metadata.engines.node;
      if (typeof required !== "string" || semver.validRange(required) === null) {
        throw new Error("npm returned an invalid Node.js version requirement.");
      }
      const nodeVersion = options.nodeVersion ?? process.versions.node;
      if (!semver.satisfies(nodeVersion, required)) {
        error(`Version ${latest} needs Node.js ${required}; you have ${nodeVersion}. Upgrade Node.js first.\n`);
        return 1;
      }
    }
    if (checkOnly) {
      write("Update available. Run chivgent update to install it.\n");
      return 0;
    }
    phase = "install the update";
    write(`Updating chivgent ${options.version} → ${latest}…\n`);
    // Pin both the checked version and the prefix belonging to this install.
    await npm(["install", "--global", "--prefix", prefix, `chivgent@${latest}`,
      "--engine-strict", "--no-audit", "--no-fund"], 300_000);
    phase = "verify the installed version";
    const installed = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as { version?: unknown };
    if (installed.version !== latest) throw new Error("The installed version does not match the requested update.");
    write(`Updated to ${latest}. Restart chivgent to use the new version.\n`);
    return 0;
  } catch (cause: unknown) {
    error(`Could not ${phase}: ${failureMessage(cause)}\n`);
    error(`Check npm availability, network access and global-directory permissions, then retry.\nManual update: ${MANUAL_UPDATE}\n`);
    return 1;
  }
}
