import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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
  readonly graders: readonly GraderSpec[];
  /** Directory copied into a fresh workspace for every attempt. */
  readonly fixtureDirectory: string;
  readonly directory: string;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_MAX_TURNS = 12;
const MAX_ATTEMPTS = 50;

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

  return {
    name,
    prompt: value.prompt,
    capabilities: readCapabilities(value.capabilities, name),
    attempts: readPositiveInteger(
      value.attempts,
      DEFAULT_ATTEMPTS,
      MAX_ATTEMPTS,
      "attempts",
      name,
    ),
    maxTurns: readPositiveInteger(
      value.maxTurns,
      DEFAULT_MAX_TURNS,
      100,
      "maxTurns",
      name,
    ),
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
