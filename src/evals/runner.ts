import type { Agent } from "../agent.js";
import { Agent as AgentClass } from "../agent.js";
import type { AgentEvent } from "../events.js";
import type { LLMClient } from "../llm.js";
import type { UsageTotal } from "../providers/usage.js";
import type { Tool } from "../tools/tool.js";
import { LocalWorkspace } from "../workspace.js";
import { ListFilesTool } from "../tools/list-files.js";
import { ReadFileTool } from "../tools/read-file.js";
import { SearchTextTool } from "../tools/search-text.js";
import { WriteFileTool } from "../tools/write-file.js";
import { EditFileTool } from "../tools/edit-file.js";
import { BashTool } from "../tools/bash.js";
import { createAttemptWorkspace } from "./fixture.js";
import { createGrader, describeGrader, type AttemptFacts } from "./graders.js";
import type { Capability, Task } from "./task.js";

export interface AttemptResult {
  readonly attempt: number;
  readonly passed: boolean;
  readonly status: AttemptFacts["status"];
  readonly turnCount: number;
  readonly durationMs: number;
  readonly toolsUsed: readonly string[];
  /** What the attempt cost, when the Provider reported it. */
  readonly usage?: UsageTotal;
  /** One entry per failed grader, in task order. */
  readonly failures: readonly string[];
}

export interface TaskResult {
  readonly task: string;
  readonly attempts: readonly AttemptResult[];
  readonly passed: number;
  readonly total: number;
}

export interface RunnerOptions {
  /** Built per attempt, so a test can hand out a fresh fake each time. */
  readonly createClient: () => LLMClient;
  readonly systemPrompt: string;
  readonly capabilities: readonly Capability[];
  readonly attempts?: number;
  readonly onAttempt?: (result: AttemptResult, task: Task) => void;
  readonly signal?: AbortSignal;
}

export class MissingCapabilityError extends Error {
  constructor(readonly task: string, readonly missing: readonly Capability[]) {
    super(
      `Task "${task}" needs ${missing.join(" and ")}; rerun with ${missing
        .map((capability) => (capability === "writes" ? "--allow-writes" : "--allow-shell"))
        .join(" ")}.`,
    );
    this.name = "MissingCapabilityError";
  }
}

function toolsFor(
  capabilities: readonly Capability[],
  cwd: string,
): readonly Tool[] {
  const tools: Tool[] = [
    new ListFilesTool(),
    new SearchTextTool(),
    new ReadFileTool(),
  ];
  if (capabilities.includes("writes")) {
    tools.push(new WriteFileTool(), new EditFileTool());
  }
  if (capabilities.includes("shell")) {
    tools.push(new BashTool({ cwd }));
  }
  return tools;
}

function missingCapabilities(
  task: Task,
  granted: readonly Capability[],
): readonly Capability[] {
  return task.capabilities.filter(
    (capability) => !granted.includes(capability),
  );
}

async function runAttempt(
  task: Task,
  attempt: number,
  options: RunnerOptions,
): Promise<AttemptResult> {
  const workspace = await createAttemptWorkspace(task.fixtureDirectory);
  const events: AgentEvent[] = [];
  const startedAt = Date.now();

  try {
    const agent: Agent = new AgentClass({
      systemPrompt: options.systemPrompt,
      maxTurns: task.maxTurns,
      llm: options.createClient(),
      tools: toolsFor(task.capabilities, workspace.path),
      workspace: new LocalWorkspace(workspace.path, {
        allowWrites: task.capabilities.includes("writes"),
      }),
      streaming: false,
      onEvent: (event) => events.push(event),
    });

    let status: AttemptFacts["status"] = "error";
    let finalAnswer = "";
    let turnCount = 0;
    let usage: UsageTotal | undefined;
    try {
      const result = await agent.run(task.prompt, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      status = result.status;
      turnCount = result.turnCount;
      usage = result.usage;
      finalAnswer =
        result.status === "completed" ? result.finalMessage.content : "";
    } catch (error: unknown) {
      // A crashed run is a failed attempt, not a failed eval run: the point is
      // to measure how often this happens, not to stop at the first one.
      status = "error";
      finalAnswer = error instanceof Error ? error.message : String(error);
    }

    const facts: AttemptFacts = {
      workspace: workspace.path,
      finalAnswer,
      turnCount,
      status,
      events,
    };

    const failures: string[] = [];
    if (status !== "completed") {
      failures.push(
        status === "max_turns"
          ? `hit the ${task.maxTurns}-turn limit without a final answer`
          : `run ended as ${status}: ${finalAnswer.split("\n", 1)[0] ?? ""}`,
      );
    }
    for (const spec of task.graders) {
      const result = await createGrader(spec)(facts);
      if (!result.passed) {
        failures.push(`${describeGrader(spec)} — ${result.reason}`);
      }
    }

    return {
      attempt,
      passed: failures.length === 0,
      status,
      turnCount,
      durationMs: Date.now() - startedAt,
      ...(usage === undefined ? {} : { usage }),
      toolsUsed: [
        ...new Set(
          events
            .filter((event) => event.type === "tool_execution_end")
            .map((event) => (event as { toolName: string }).toolName),
        ),
      ],
      failures,
    };
  } finally {
    await workspace.dispose();
  }
}

/**
 * Runs one task N times.
 *
 * The result is a pass rate, not a verdict: one attempt against a
 * nondeterministic model says almost nothing, so the runner never reports a
 * single attempt as the task's outcome.
 */
export async function runTask(
  task: Task,
  options: RunnerOptions,
): Promise<TaskResult> {
  const missing = missingCapabilities(task, options.capabilities);
  if (missing.length > 0) {
    throw new MissingCapabilityError(task.name, missing);
  }

  const total = options.attempts ?? task.attempts;
  const attempts: AttemptResult[] = [];
  for (let index = 1; index <= total; index += 1) {
    const result = await runAttempt(task, index, options);
    attempts.push(result);
    options.onAttempt?.(result, task);
  }

  return {
    task: task.name,
    attempts,
    passed: attempts.filter((attempt) => attempt.passed).length,
    total,
  };
}

export async function runTasks(
  tasks: readonly Task[],
  options: RunnerOptions,
): Promise<readonly TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, options));
  }
  return results;
}
