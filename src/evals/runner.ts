import type { Agent } from "../agent.js";
import { Agent as AgentClass } from "../agent.js";
import type { AgentEvent } from "../events.js";
import type { LLMClient } from "../llm.js";
import type { UsageTotal } from "../providers/usage.js";
import { LocalWorkspace } from "../workspace.js";
import { toolsFor } from "./tools.js";
import { createAttemptWorkspace } from "./fixture.js";
import { createGrader, describeGrader, type AttemptFacts } from "./graders.js";
import type { Capability, Task } from "./task.js";

/** One tool result, in call order. Arguments are deliberately not kept. */
export interface ToolCallRecord {
  readonly name: string;
  readonly ok: boolean;
}

export interface AttemptResult {
  readonly attempt: number;
  readonly passed: boolean;
  readonly status: AttemptFacts["status"];
  readonly turnCount: number;
  readonly durationMs: number;
  readonly toolsUsed: readonly string[];
  /**
   * Every call in order, with whether it succeeded.
   *
   * `toolsUsed` is a deduplicated set, so a model that guessed a path, got an
   * error and recovered looks identical there to one that never guessed. This
   * is what makes that question answerable from the report.
   */
  readonly toolCalls: readonly ToolCallRecord[];
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
  /**
   * Called once per attempt, so a test can hand out a fresh fake each time.
   * The CLI returns the same client every time on purpose: it holds only
   * readonly config and takes the history per request, so attempts cannot
   * leak into one another through it.
   */
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
      fixtureDirectory: task.fixtureDirectory,
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

    const calls: readonly ToolCallRecord[] = events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => ({
        name: (event as { toolName: string }).toolName,
        ok: (event as { isError: boolean }).isError === false,
      }));

    return {
      attempt,
      passed: failures.length === 0,
      status,
      turnCount,
      durationMs: Date.now() - startedAt,
      ...(usage === undefined ? {} : { usage }),
      toolsUsed: [...new Set(calls.map((call) => call.name))],
      toolCalls: calls,
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
