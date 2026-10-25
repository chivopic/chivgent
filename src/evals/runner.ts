import { Agent, type AgentOptions } from "../agent.js";
import { AgentSession } from "../session.js";
import { FileSessionStore, type SessionStore } from "../session-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentEvent } from "../events.js";
import type { LLMClient } from "../llm.js";
import type { UsageTotal } from "../providers/usage.js";
import { LocalWorkspace } from "../workspace.js";
import { callTarget } from "../tools/target.js";
import { toolsFor } from "./tools.js";
import type { ShellOperations } from "../shell/types.js";
import { createAttemptWorkspace } from "./fixture.js";
import { ScopedProjectInstructions } from "../context/project-instructions.js";
import { ContextManager } from "../context/context-manager.js";
import { Compactor } from "../context/compaction.js";
import { createGrader, describeGrader, type AttemptFacts } from "./graders.js";
import type { Capability, Task } from "./task.js";

/** One tool result, in call order. */
export interface ToolCallRecord {
  readonly name: string;
  readonly ok: boolean;
  /**
   * What the call was aimed at: the `path` argument, or a truncated `command`.
   *
   * Full arguments are not kept — an edit carries both halves of the change
   * and would bury the report in file contents. But a name and a success flag
   * alone cannot tell a model that read the four files on an import chain from
   * one that read four unrelated files, and on a task built out of 41 files
   * that distinction is the entire measurement. Omitted when the tool takes
   * neither.
   */
  readonly target?: string;
}

export interface AttemptResult {
  readonly attempt: number;
  readonly passed: boolean;
  readonly status: AttemptFacts["status"];
  readonly turnCount: number;
  readonly durationMs: number;
  /** Successful ContextManager compactions; omitted for ordinary tasks. */
  readonly compactionCount?: number;
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
  /** Test-only execution override; the default is the Docker sandbox. */
  readonly shellOperations?: ShellOperations;
  /** Test seam for session recovery failures; production uses FileSessionStore. */
  readonly createSessionStore?: (home: string) => SessionStore;
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
  let compactionCount = 0;
  let store: SessionStore | undefined;
  let sessionRoot: string | undefined;
  let session: AgentSession | undefined;
  let ordinaryAgent: Agent | undefined;

  try {
    const llm = options.createClient();
    const agent: Omit<AgentOptions, "onEvent"> = {
      systemPrompt: options.systemPrompt,
      maxTurns: task.maxTurns,
      llm,
      tools: toolsFor(task.capabilities, workspace.path, {
        ...(options.shellOperations === undefined ? {} : { shellOperations: options.shellOperations }),
      }),
      workspace: new LocalWorkspace(workspace.path, {
        allowWrites: task.capabilities.includes("writes"),
      }),
      streaming: false,
      projectInstructions: new ScopedProjectInstructions(workspace.path),
      ...(task.contextWindow === undefined ? {} : {
        contextManager: new ContextManager({
          contextWindow: task.contextWindow,
          compactor: new Compactor(llm),
          onCompaction: () => { compactionCount += 1; },
        }),
      }),
    };
    const followUps = task.followUps ?? [];
    const prompts = [task.prompt, ...followUps];
    const recoverAfter = new Set(task.recoverAfter ?? []);
    const sessionId = `eval-${task.name.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 32)}-${attempt}`;
    if (followUps.length === 0) {
      // Keep ordinary benchmark tasks on their original stateless Agent path.
      ordinaryAgent = new Agent({ ...agent, onEvent: (event) => events.push(event) });
    } else {
      sessionRoot = await mkdtemp(path.join(tmpdir(), "chivgent-eval-session-"));
      store = options.createSessionStore?.(sessionRoot) ?? new FileSessionStore(sessionRoot);
      session = new AgentSession({ agent, id: sessionId, cwd: workspace.path, store });
      session.subscribe((event) => events.push(event));
    }

    let status: AttemptFacts["status"] = "error";
    let finalAnswer = "";
    let turnCount = 0;
    let usage: UsageTotal | undefined;
    try {
      if (session === undefined) {
        const result = await ordinaryAgent!.run(task.prompt, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        status = result.status;
        turnCount = result.turnCount;
        usage = result.usage;
        finalAnswer = result.status === "completed" ? result.finalMessage.content : "";
      } else {
        for (const [index, prompt] of prompts.entries()) {
          const result = await session.prompt(prompt, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          status = result.status;
          turnCount += result.turnCount;
          finalAnswer = result.status === "completed" ? result.finalMessage.content : "";
          if (result.status !== "completed") break;

          // Recovery follows the production JSONL read/validation path.
          if (recoverAfter.has(index + 1)) {
            await store!.flush?.();
            const saved = await store!.read(sessionId);
            if (saved === undefined) throw new Error("Eval session recovery could not read its saved session.");
            await session.close();
            session = new AgentSession({
              agent,
              id: sessionId,
              cwd: workspace.path,
              store: store!,
              messages: saved.messages,
              ...(saved.compaction === undefined ? {} : { compaction: saved.compaction }),
              ...(saved.usage === undefined ? {} : { usage: saved.usage }),
              promptCount: saved.promptCount,
              ...(saved.title === undefined ? {} : { title: saved.title }),
              planMode: saved.planMode,
              resumed: true,
            });
            session.subscribe((event) => events.push(event));
          }
        }
        usage = session.usage;
        // A failed Provider request still emits turn_start but no run result;
        // count the whole conversation from events so in-flight failed turns
        // are visible in the benchmark report.
        turnCount = events.filter((event) => event.type === "turn_start").length;
      }
    } catch (error: unknown) {
      // A crashed run is a failed attempt, not a failed eval run: the point is
      // to measure how often this happens, not to stop at the first one.
      status = "error";
      finalAnswer = error instanceof Error ? error.message : String(error);
      usage = session?.usage;
      if (session !== undefined) {
        turnCount = events.filter((event) => event.type === "turn_start").length;
      }
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

    // The arguments live on the start event, the outcome on the end event;
    // the call id is what joins them.
    const targets = new Map<string, string>();
    for (const event of events) {
      if (event.type === "tool_execution_start") {
        const target = callTarget(event.arguments);
        if (target !== undefined) {
          targets.set(event.toolCallId, target);
        }
      }
    }
    const calls: readonly ToolCallRecord[] = events
      .filter((event) => event.type === "tool_execution_end")
      .map((event) => {
        const end = event as {
          toolName: string;
          isError: boolean;
          toolCallId: string;
        };
        const target = targets.get(end.toolCallId);
        return {
          name: end.toolName,
          ok: end.isError === false,
          ...(target === undefined ? {} : { target }),
        };
      });

    return {
      attempt,
      passed: failures.length === 0,
      status,
      turnCount,
      durationMs: Date.now() - startedAt,
      ...(task.contextWindow === undefined ? {} : { compactionCount }),
      ...(usage === undefined ? {} : { usage }),
      toolsUsed: [...new Set(calls.map((call) => call.name))],
      toolCalls: calls,
      failures,
    };
  } finally {
    try {
      await store?.flush?.().catch(() => undefined);
      await session?.close();
      await ordinaryAgent?.close();
    } finally {
      try {
        if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true });
      } finally {
        await workspace.dispose();
      }
    }
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
