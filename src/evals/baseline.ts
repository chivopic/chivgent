import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createGrader } from "./graders.js";
import { TaskError, type Capability, type Task } from "./task.js";

const exec = promisify(execFile);

export interface SuiteEntry {
  readonly name: string;
  readonly sha256: string;
  readonly attempts: number;
  readonly maxTurns: number;
  readonly capabilities: readonly Capability[];
}

export interface SuiteManifest {
  readonly suiteSha256: string;
  readonly tasks: readonly SuiteEntry[];
}

export interface BaselineManifest {
  readonly suite: SuiteManifest;
  readonly revision: string | null;
  readonly dirty: boolean | null;
  readonly provider: string;
  readonly model: string;
  readonly grantedCapabilities: readonly Capability[];
  readonly attemptedTasks: readonly string[];
  readonly skippedTasks: readonly string[];
  readonly attemptsOverride: number | null;
  readonly promptSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, relative: string): boolean {
  const resolved = path.resolve(root, relative);
  const remainder = path.relative(root, resolved);
  return remainder !== ".." && !remainder.startsWith(`..${path.sep}`) && !path.isAbsolute(remainder);
}

/** Fail before any billed model calls when a grader is malformed. */
async function preflightTask(task: Task): Promise<void> {
  for (const grader of task.graders) {
    try {
      createGrader(grader);
    } catch (error: unknown) {
      throw new TaskError(`${task.name}: invalid ${grader.type} grader: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof grader.path === "string" && !inside(task.fixtureDirectory, grader.path)) {
      throw new TaskError(`${task.name}: grader path leaves the fixture: ${grader.path}`);
    }
    if (grader.type === "file-unchanged") {
      const file = path.join(task.fixtureDirectory, grader.path as string);
      try {
        if (!(await stat(file)).isFile()) throw new Error("not a file");
      } catch {
        throw new TaskError(`${task.name}: file-unchanged requires an existing fixture file: ${grader.path}`);
      }
    }
  }
}

/** Hash both the task definition and fixture bytes, independent of directory location. */
async function hashTask(task: Task): Promise<string> {
  const hash = createHash("sha256");
  async function addFile(file: string, relative: string): Promise<void> {
    const bytes = await readFile(file);
    hash.update("file\0").update(relative).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  await addFile(path.join(task.directory, "task.json"), "task.json");

  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new TaskError(`${task.name}: fixture contains a symlink: ${relative}`);
      }
      if (entry.isDirectory()) {
        hash.update("dir\0").update(relative).update("\0");
        await walk(path.join(directory, entry.name), `${relative}/`);
      } else if (entry.isFile()) {
        await addFile(path.join(directory, entry.name), relative);
      } else {
        throw new TaskError(`${task.name}: unsupported fixture entry: ${relative}`);
      }
    }
  }
  await walk(task.fixtureDirectory, "fixture/");
  return hash.digest("hex");
}

export async function describeSuite(tasks: readonly Task[]): Promise<SuiteManifest> {
  const names = new Set<string>();
  const entries: SuiteEntry[] = [];
  for (const task of [...tasks].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (names.has(task.name)) throw new TaskError(`Duplicate task name: ${task.name}`);
    names.add(task.name);
    await preflightTask(task);
    entries.push({
      name: task.name,
      sha256: await hashTask(task),
      attempts: task.attempts,
      maxTurns: task.maxTurns,
      capabilities: task.capabilities,
    });
  }
  return { suiteSha256: sha256(entries.map((entry) => `${entry.name}\0${entry.sha256}\n`).join("")), tasks: entries };
}

/** Unknown Git state stays unknown; do not pretend it is a clean checkout. */
export async function gitRevision(cwd: string = process.cwd()): Promise<{ revision: string | null; dirty: boolean | null }> {
  try {
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 3000 })).stdout.trim();
    const status = (await exec("git", ["status", "--porcelain"], { cwd, timeout: 3000 })).stdout;
    return { revision, dirty: status.trim().length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

export function buildBaselineManifest(
  suite: SuiteManifest,
  git: { revision: string | null; dirty: boolean | null },
  options: {
    readonly provider: string;
    readonly model: string;
    readonly capabilities: readonly Capability[];
    readonly attemptsOverride?: number;
    readonly systemPrompts: readonly string[];
  },
): BaselineManifest {
  return {
    suite,
    ...git,
    provider: options.provider,
    model: options.model,
    grantedCapabilities: options.capabilities,
    attemptedTasks: suite.tasks.filter(t => t.capabilities.every(cap => options.capabilities.includes(cap))).map(t => t.name),
    skippedTasks: suite.tasks.filter(t => t.capabilities.some(cap => !options.capabilities.includes(cap))).map(t => t.name),
    attemptsOverride: options.attemptsOverride ?? null,
    promptSha256: sha256(options.systemPrompts.join("\0")),
  };
}
