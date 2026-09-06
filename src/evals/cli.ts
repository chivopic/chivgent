#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseCliArgs, VERSION } from "../cli-options.js";
import { createConfiguredClient } from "../providers/client.js";
import {
  SHELL_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  WRITE_SYSTEM_PROMPT,
} from "../prompts.js";
import { formatFailures, formatTable, toJsonReport } from "./report.js";
import { MissingCapabilityError, runTask, type TaskResult } from "./runner.js";
import { loadTasks, TaskError, type Capability, type Task } from "./task.js";
import { parseEvalArgs, type EvalOptions } from "./parse-args.js";

const HELP = `chivgent evals ${VERSION}

Usage:
  npm run eval -- [options]

Options:
  --task NAME        Run only this task (repeatable)
  --attempts N       Override the attempts each task declares
  --dir PATH         Task directory (default: evals)
  --json PATH        Also write a JSON report
  --provider NAME    Provider to evaluate
  --model MODEL      Model to evaluate
  --allow-writes     Grant tasks that need to change files
  --allow-shell      Grant tasks that need a shell
  -h, --help         Show this help

Evals need real credentials and cost money. They are not part of npm test:
a model is nondeterministic, so a task's result is a pass rate over several
attempts rather than a verdict, and that is not something to gate a merge on.
`;


function buildSystemPrompt(capabilities: readonly Capability[]): string {
  const sections = [SYSTEM_PROMPT];
  if (capabilities.includes("writes")) {
    sections.push(WRITE_SYSTEM_PROMPT);
  }
  if (capabilities.includes("shell")) {
    sections.push(SHELL_SYSTEM_PROMPT);
  }
  return sections.join("\n");
}

function selectTasks(
  all: readonly Task[],
  wanted: readonly string[],
): readonly Task[] {
  if (wanted.length === 0) {
    return all;
  }
  const known = new Set(all.map((task) => task.name));
  for (const name of wanted) {
    if (!known.has(name)) {
      throw new TaskError(
        `Unknown task "${name}". Available: ${[...known].join(", ")}.`,
      );
    }
  }
  return all.filter((task) => wanted.includes(task.name));
}

async function main(argv: readonly string[]): Promise<number> {
  let options: EvalOptions;
  try {
    options = parseEvalArgs(argv);
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let tasks: readonly Task[];
  try {
    tasks = selectTasks(
      await loadTasks(path.resolve(options.directory)),
      options.tasks,
    );
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (tasks.length === 0) {
    process.stderr.write(`No tasks found in ${options.directory}.\n`);
    return 1;
  }

  const cliOptions = parseCliArgs([...options.providerArgs], process.env);
  const llm = await createConfiguredClient(cliOptions);
  if (typeof llm === "string") {
    // The same configuration message the main CLI gives, rather than a run of
    // zero scores that looks like the agent failing.
    process.stderr.write(`${llm}\n`);
    return 1;
  }

  const startedAt = new Date().toISOString();
  process.stderr.write(
    `Evaluating ${cliOptions.provider}/${cliOptions.model ?? "?"} on ${tasks.length} task(s).\n\n`,
  );

  const results: TaskResult[] = [];
  for (const task of tasks) {
    try {
      results.push(
        await runTask(task, {
          createClient: () => llm,
          systemPrompt: buildSystemPrompt(task.capabilities),
          capabilities: options.capabilities,
          ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
          onAttempt: (result) => {
            process.stderr.write(
              `  ${task.name} ${result.attempt}: ${result.passed ? "pass" : "fail"}\n`,
            );
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof MissingCapabilityError) {
        process.stderr.write(`skipped: ${error.message}\n`);
        continue;
      }
      throw error;
    }
  }

  process.stdout.write(`\n${formatTable(results)}`);
  const failures = formatFailures(results);
  if (failures.length > 0) {
    process.stdout.write(`\n${failures}`);
  }

  if (options.jsonPath !== undefined) {
    const report = toJsonReport(results, {
      provider: cliOptions.provider,
      model: cliOptions.model ?? "unknown",
      version: VERSION,
      startedAt,
    });
    await writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`\nWrote ${options.jsonPath}\n`);
  }

  // Exit 0 even when tasks fail: a pass rate is a measurement, not a gate.
  return 0;
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Eval runner failed: ${message}\n`);
    process.exitCode = 1;
  });
