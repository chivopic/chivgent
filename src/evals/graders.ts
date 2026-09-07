import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GraderSpec, TaskError } from "./task.js";
import type { AgentEvent } from "../events.js";

export interface AttemptFacts {
  /** The workspace as the attempt left it. */
  readonly workspace: string;
  /** The pristine fixture, for graders that ask what the attempt changed. */
  readonly fixtureDirectory: string;
  readonly finalAnswer: string;
  readonly turnCount: number;
  readonly status: "completed" | "max_turns" | "aborted" | "error";
  readonly events: readonly AgentEvent[];
}

export interface GraderResult {
  readonly passed: boolean;
  /** Why it failed, specific enough to act on. Empty when it passed. */
  readonly reason: string;
}

export type Grader = (facts: AttemptFacts) => Promise<GraderResult>;

const pass: GraderResult = { passed: true, reason: "" };

function fail(reason: string): GraderResult {
  return { passed: false, reason };
}

function requireString(spec: GraderSpec, field: string): string {
  const value = spec[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${spec.type}: "${field}" must be a non-empty string.`);
  }
  return value;
}

async function readWorkspaceFile(
  workspace: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(path.join(workspace, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

/** Tool names that produced a result, in call order, errors included. */
function toolCalls(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "tool_execution_end")
    .map((event) => (event as { toolName: string }).toolName);
}

function failedToolCalls(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as { isError: boolean }).isError === true,
    )
    .map((event) => (event as { toolName: string }).toolName);
}

function successfulToolCalls(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as { isError: boolean }).isError === false,
    )
    .map((event) => (event as { toolName: string }).toolName);
}

/** 1-based line where two texts first differ, for an actionable failure. */
function firstDifferingLine(before: string, after: string): number {
  const left = before.split("\n");
  const right = after.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return index + 1;
    }
  }
  return 1;
}

type GraderFactory = (spec: GraderSpec) => Grader;

const factories: Record<string, GraderFactory> = {
  "file-contains": (spec) => {
    const file = requireString(spec, "path");
    const text = requireString(spec, "text");
    return async ({ workspace }) => {
      const contents = await readWorkspaceFile(workspace, file);
      if (contents === undefined) {
        return fail(`${file} does not exist`);
      }
      return contents.includes(text)
        ? pass
        : fail(`${file} does not contain ${JSON.stringify(text)}`);
    };
  },

  "file-excludes": (spec) => {
    const file = requireString(spec, "path");
    const text = requireString(spec, "text");
    return async ({ workspace }) => {
      const contents = await readWorkspaceFile(workspace, file);
      if (contents === undefined) {
        return fail(`${file} does not exist`);
      }
      if (!contents.includes(text)) {
        return pass;
      }
      // Naming the line makes the failure actionable without opening the file.
      const line =
        contents.slice(0, contents.indexOf(text)).split("\n").length;
      return fail(
        `${file} still contains ${JSON.stringify(text)} at line ${line}`,
      );
    };
  },

  "file-exists": (spec) => {
    const file = requireString(spec, "path");
    return async ({ workspace }) => {
      try {
        await stat(path.join(workspace, file));
        return pass;
      } catch {
        return fail(`${file} was not created`);
      }
    };
  },

  "file-absent": (spec) => {
    const file = requireString(spec, "path");
    return async ({ workspace }) => {
      try {
        await stat(path.join(workspace, file));
        return fail(`${file} still exists`);
      } catch {
        return pass;
      }
    };
  },

  "file-equals": (spec) => {
    const file = requireString(spec, "path");
    const text = requireString(spec, "text");
    return async ({ workspace }) => {
      const contents = await readWorkspaceFile(workspace, file);
      if (contents === undefined) {
        return fail(`${file} does not exist`);
      }
      return contents === text
        ? pass
        : fail(`${file} does not match the expected contents byte for byte`);
    };
  },

  "used-tool": (spec) => {
    const name = requireString(spec, "name");
    return async ({ events }) => {
      const used = toolCalls(events);
      return used.includes(name)
        ? pass
        : fail(
            `never called ${name}; called ${used.length === 0 ? "nothing" : [...new Set(used)].join(", ")}`,
          );
    };
  },

  "not-used-tool": (spec) => {
    const name = requireString(spec, "name");
    return async ({ events }) => {
      const used = toolCalls(events);
      const count = used.filter((tool) => tool === name).length;
      return count === 0
        ? pass
        : fail(`called ${name} ${count} time(s), which this task forbids`);
    };
  },

  "tool-succeeded": (spec) => {
    const name = requireString(spec, "name");
    return async ({ events }) => {
      return successfulToolCalls(events).includes(name)
        ? pass
        : fail(`${name} never returned a successful result`);
    };
  },

  "tool-never-failed": (spec) => {
    // Sound only where a failure means the model was wrong. `bash` sets
    // isError on any non-zero exit, so on a task that runs a failing test —
    // fix-failing-test, wrong-test — the correct behaviour is a failed call
    // and this grader would punish it.
    const name = requireString(spec, "name");
    return async ({ events }) => {
      // A guessed path shows up here: reading a file that is not there is the
      // failure, and the set of tool names a report keeps cannot see it.
      const failures = failedToolCalls(events).filter((tool) => tool === name);
      return failures.length === 0
        ? pass
        : fail(
            `${name} failed ${failures.length} time(s); this task expects it to be called only on paths the model established exist`,
          );
    };
  },

  "max-tool-calls": (spec) => {
    const name = requireString(spec, "name");
    const limit = spec.count;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
      throw new Error('max-tool-calls: "count" must be a positive integer.');
    }
    return async ({ events }) => {
      // Turns cannot express this: a model may issue any number of calls in
      // one turn, so "did it read the whole project" is a call count, not a
      // turn count.
      // Failed calls count. A budget that forgave them would let a model
      // spend freely on guessed paths, which is the opposite of the intent.
      const used = toolCalls(events).filter((tool) => tool === name).length;
      return used <= (limit as number)
        ? pass
        : fail(`called ${name} ${used} times, over the budget of ${limit as number}`);
    };
  },

  "file-unchanged": (spec) => {
    const file = requireString(spec, "path");
    return async ({ workspace, fixtureDirectory }) => {
      // Compared against the fixture rather than against text copied into
      // task.json, so there is no second copy to keep in sync.
      const before = await readWorkspaceFile(fixtureDirectory, file);
      if (before === undefined) {
        throw new Error(
          `file-unchanged: ${file} is not in the fixture, so there is nothing to compare against.`,
        );
      }
      const after = await readWorkspaceFile(workspace, file);
      if (after === undefined) {
        return fail(`${file} was deleted; this task expects it untouched`);
      }
      if (after === before) {
        return pass;
      }
      const line = firstDifferingLine(before, after);
      return fail(
        `${file} was modified at line ${line}; this task expects it untouched`,
      );
    };
  },

  "answer-matches": (spec) => {
    const pattern = requireString(spec, "pattern");
    const flags = typeof spec.flags === "string" ? spec.flags : "i";
    const expression = new RegExp(pattern, flags);
    return async ({ finalAnswer }) => {
      return expression.test(finalAnswer)
        ? pass
        : fail(
            `the answer did not match /${pattern}/${flags}: ${JSON.stringify(finalAnswer.slice(0, 120))}`,
          );
    };
  },

  "answer-excludes": (spec) => {
    const pattern = requireString(spec, "pattern");
    const flags = typeof spec.flags === "string" ? spec.flags : "i";
    const expression = new RegExp(pattern, flags);
    return async ({ finalAnswer }) => {
      return expression.test(finalAnswer)
        ? fail(`the answer matched /${pattern}/${flags}, which this task forbids`)
        : pass;
    };
  },

  "max-turns-under": (spec) => {
    const limit = spec.turns;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
      throw new Error("max-turns-under: \"turns\" must be a positive integer.");
    }
    return async ({ turnCount }) => {
      return turnCount <= (limit as number)
        ? pass
        : fail(`took ${turnCount} turns, over the limit of ${limit as number}`);
    };
  },
};

export const GRADER_TYPES: readonly string[] = Object.keys(factories);

export function createGrader(spec: GraderSpec): Grader {
  const factory = factories[spec.type];
  if (factory === undefined) {
    throw new Error(
      `Unknown grader type "${spec.type}". Known types: ${GRADER_TYPES.join(", ")}.`,
    );
  }
  return factory(spec);
}

export function describeGrader(spec: GraderSpec): string {
  const detail = Object.entries(spec)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return detail.length === 0 ? spec.type : `${spec.type} ${detail}`;
}

export type { TaskError };
