import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GraderSpec, TaskError } from "./task.js";
import type { AgentEvent } from "../events.js";

export interface AttemptFacts {
  /** The workspace as the attempt left it. */
  readonly workspace: string;
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

function successfulToolCalls(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter(
      (event) =>
        event.type === "tool_execution_end" &&
        (event as { isError: boolean }).isError === false,
    )
    .map((event) => (event as { toolName: string }).toolName);
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
