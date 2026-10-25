import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { toolNamesFor } from "./tools.js";

export class TaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "TaskError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Capabilities a task needs; the runner refuses to run without them. */
export type Capability = "writes" | "shell";

export interface GraderSpec {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface Task {
  readonly name: string;
  readonly prompt: string;
  readonly capabilities: readonly Capability[];
  readonly attempts: number;
  readonly maxTurns: number;
  /** Enables the production ContextManager path for this task only. */
  readonly contextWindow?: number;
  /** Additional user messages in the same opt-in session. */
  readonly followUps?: readonly string[];
  /** One-based prompt numbers after which the runner reloads the saved session. */
  readonly recoverAfter?: readonly number[];
  readonly graders: readonly GraderSpec[];
  /** Directory copied into a fresh workspace for every attempt. */
  readonly fixtureDirectory: string;
  readonly directory: string;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_MAX_TURNS = 12;
const MAX_ATTEMPTS = 50;
const MAX_FOLLOW_UPS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCapabilities(value: unknown, name: string): readonly Capability[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TaskError(`${name}: capabilities must be an array.`);
  }
  return value.map((entry) => {
    if (entry !== "writes" && entry !== "shell") {
      throw new TaskError(
        `${name}: unknown capability ${JSON.stringify(entry)}; expected "writes" or "shell".`,
      );
    }
    return entry;
  });
}

function readPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TaskError(
      `${name}: ${field} must be an integer from 1 to ${maximum}.`,
    );
  }
  return value as number;
}

/** Grader types whose "name" must be a tool the task actually grants. */
const TOOL_NAME_GRADERS = new Set([
  "used-tool",
  "not-used-tool",
  "tool-succeeded",
  "tool-never-failed",
  "max-tool-calls",
]);

/**
 * Refuses a grader that names a tool the task never hands to the model.
 *
 * `not-used-tool: write_file` on a read-only task can never fail — it asserts
 * the model did not call something it was never given, so it reads like a
 * check and is worth nothing. The mirror image, `used-tool` on a tool the task
 * withholds, can never pass. Both are task-definition mistakes, and both are
 * caught here rather than at run time so they cost nothing to find.
 */
function assertGradersCanFire(
  name: string,
  capabilities: readonly Capability[],
  graders: readonly GraderSpec[],
): void {
  const available = toolNamesFor(capabilities);
  for (const [index, grader] of graders.entries()) {
    if (!TOOL_NAME_GRADERS.has(grader.type)) {
      continue;
    }
    const tool = grader.name;
    if (typeof tool !== "string" || available.includes(tool)) {
      continue;
    }
    throw new TaskError(
      `${name}: graders[${index}] (${grader.type}) names "${tool}", which this task never grants. ` +
        `Available with capabilities [${capabilities.join(", ")}]: ${available.join(", ")}. ` +
        `Grant the capability or drop the grader.`,
    );
  }
}

export function parseTask(
  value: unknown,
  directory: string,
  fixtureDirectory: string,
): Task {
  if (!isRecord(value)) {
    throw new TaskError(`${directory}: task.json must contain a JSON object.`);
  }
  const name =
    typeof value.name === "string" && value.name.length > 0
      ? value.name
      : path.basename(directory);
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    throw new TaskError(`${name}: prompt must be a non-empty string.`);
  }
  if (!Array.isArray(value.graders) || value.graders.length === 0) {
    throw new TaskError(`${name}: at least one grader is required.`);
  }
  const graders = value.graders.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.type !== "string") {
      throw new TaskError(`${name}: graders[${index}] needs a type.`);
    }
    return entry as GraderSpec;
  });

  const capabilities = readCapabilities(value.capabilities, name);
  assertGradersCanFire(name, capabilities, graders);
  const contextWindow =
    value.contextWindow === undefined
      ? undefined
      : readPositiveInteger(
          value.contextWindow,
          0,
          Number.MAX_SAFE_INTEGER,
          "contextWindow",
          name,
        );
  if (contextWindow !== undefined && contextWindow < 1_000) {
    throw new TaskError(`${name}: contextWindow must be an integer of at least 1000.`);
  }

  let followUps: readonly string[] | undefined;
  if (value.followUps !== undefined) {
    if (
      !Array.isArray(value.followUps) ||
      value.followUps.length === 0 ||
      value.followUps.length > MAX_FOLLOW_UPS ||
      !value.followUps.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      throw new TaskError(`${name}: followUps must contain 1 to ${MAX_FOLLOW_UPS} non-empty strings.`);
    }
    followUps = value.followUps;
  }

  const followUpCount = followUps?.length ?? 0;
  let recoverAfter: readonly number[] | undefined;
  if (value.recoverAfter !== undefined) {
    if (
      followUps === undefined ||
      !Array.isArray(value.recoverAfter) ||
      !value.recoverAfter.every(
        (item) => Number.isSafeInteger(item) && (item as number) >= 1 && (item as number) <= followUps!.length,
      ) ||
      new Set(value.recoverAfter).size !== value.recoverAfter.length ||
      value.recoverAfter.some(
        (item, index) => index > 0 && (item as number) <= (value.recoverAfter as number[])[index - 1]!,
      )
    ) {
      throw new TaskError(`${name}: recoverAfter must be ordered unique prompt numbers from 1 to ${followUpCount} and requires followUps.`);
    }
    recoverAfter = value.recoverAfter as number[];
  }

  const attempts = readPositiveInteger(
    value.attempts,
    DEFAULT_ATTEMPTS,
    MAX_ATTEMPTS,
    "attempts",
    name,
  );
  const maxTurns = readPositiveInteger(
    value.maxTurns,
    DEFAULT_MAX_TURNS,
    100,
    "maxTurns",
    name,
  );

  return {
    name,
    prompt: value.prompt,
    capabilities,
    attempts,
    maxTurns,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(followUps === undefined ? {} : { followUps }),
    ...(recoverAfter === undefined ? {} : { recoverAfter }),
    graders,
    fixtureDirectory,
    directory,
  };
}

export async function loadTask(directory: string): Promise<Task> {
  const file = path.join(directory, "task.json");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error: unknown) {
    throw new TaskError(`Could not read ${file}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error: unknown) {
    throw new TaskError(`${file} is not valid JSON.`, { cause: error });
  }
  return parseTask(parsed, directory, path.join(directory, "fixture"));
}

/** Every subdirectory holding a task.json, in name order. */
export async function loadTasks(root: string): Promise<readonly Task[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    throw new TaskError(`Could not read the eval directory ${root}.`, {
      cause: error,
    });
  }

  const tasks: Task[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      await stat(path.join(directory, "task.json"));
    } catch {
      continue;
    }
    tasks.push(await loadTask(directory));
  }
  return tasks;
}
