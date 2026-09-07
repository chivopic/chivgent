import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrader, GRADER_TYPES } from "../src/evals/graders.js";
import type { AttemptFacts } from "../src/evals/graders.js";
import { createAttemptWorkspace } from "../src/evals/fixture.js";
import { loadTask, loadTasks, parseTask, TaskError } from "../src/evals/task.js";
import { parseEvalArgs } from "../src/evals/parse-args.js";
import { MissingCapabilityError, runTask } from "../src/evals/runner.js";
import { formatFailures, formatTable, toJsonReport } from "../src/evals/report.js";
import { assistant, FakeLLMClient } from "./fakes.js";
import type { LLMResponse } from "../src/llm.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-evaltest-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function facts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    workspace: "/nowhere",
    finalAnswer: "",
    turnCount: 1,
    status: "completed",
    events: [],
    ...overrides,
  };
}

function toolEnd(toolName: string, isError = false) {
  return {
    type: "tool_execution_end" as const,
    turn: 1,
    toolCallId: `call-${toolName}`,
    toolName,
    content: "",
    isError,
  };
}

/** A task directory on disk, since that is what the loader consumes. */
async function writeTask(
  root: string,
  name: string,
  task: object,
  fixture: Record<string, string> = {},
): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "fixture"), { recursive: true });
  await writeFile(path.join(directory, "task.json"), JSON.stringify(task));
  for (const [file, contents] of Object.entries(fixture)) {
    const target = path.join(directory, "fixture", file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return directory;
}

describe("task parsing", () => {
  const valid = {
    name: "demo",
    prompt: "do the thing",
    graders: [{ type: "file-exists", path: "a.txt" }],
  };

  it("fills in the defaults", () => {
    const task = parseTask(valid, "/tasks/demo", "/tasks/demo/fixture");

    expect(task).toMatchObject({ name: "demo", attempts: 5, maxTurns: 12 });
    expect(task.capabilities).toEqual([]);
  });

  it("rejects a task with no graders", () => {
    expect(() => parseTask({ ...valid, graders: [] }, "/d", "/f")).toThrow(TaskError);
  });

  it("rejects an empty prompt", () => {
    expect(() => parseTask({ ...valid, prompt: "  " }, "/d", "/f")).toThrow(/prompt/);
  });

  it("rejects an unknown capability", () => {
    expect(() =>
      parseTask({ ...valid, capabilities: ["network"] }, "/d", "/f"),
    ).toThrow(/unknown capability/);
  });

  it("rejects a nonsensical attempt count", () => {
    expect(() => parseTask({ ...valid, attempts: 0 }, "/d", "/f")).toThrow(/attempts/);
    expect(() => parseTask({ ...valid, attempts: 1000 }, "/d", "/f")).toThrow(/attempts/);
  });

  it("rejects a grader with no type", () => {
    expect(() =>
      parseTask({ ...valid, graders: [{ path: "a" }] }, "/d", "/f"),
    ).toThrow(/needs a type/);
  });

  it("loads every task directory in name order", async () => {
    const root = await temporaryDirectory();
    await writeTask(root, "b-task", { ...valid, name: "b-task" });
    await writeTask(root, "a-task", { ...valid, name: "a-task" });
    await mkdir(path.join(root, "not-a-task"), { recursive: true });

    const tasks = await loadTasks(root);

    expect(tasks.map((task) => task.name)).toEqual(["a-task", "b-task"]);
  });

  it("reports malformed JSON instead of skipping the task", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "broken");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.json"), "{ not json");

    await expect(loadTask(directory)).rejects.toBeInstanceOf(TaskError);
  });
});

describe("graders", () => {
  it("checks file contents", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "a.txt"), "hello world\n");

    const contains = createGrader({ type: "file-contains", path: "a.txt", text: "world" });
    const excludes = createGrader({ type: "file-excludes", path: "a.txt", text: "world" });

    expect(await contains(facts({ workspace }))).toMatchObject({ passed: true });
    const failure = await excludes(facts({ workspace }));
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain("line 1");
  });

  it("says the file is missing rather than silently failing the text check", async () => {
    const workspace = await temporaryDirectory();
    const grader = createGrader({ type: "file-contains", path: "gone.txt", text: "x" });

    expect(await grader(facts({ workspace }))).toMatchObject({
      passed: false,
      reason: "gone.txt does not exist",
    });
  });

  it("checks existence and absence", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "there.txt"), "");

    expect(
      await createGrader({ type: "file-exists", path: "there.txt" })(facts({ workspace })),
    ).toMatchObject({ passed: true });
    expect(
      await createGrader({ type: "file-absent", path: "there.txt" })(facts({ workspace })),
    ).toMatchObject({ passed: false });
    expect(
      await createGrader({ type: "file-absent", path: "gone.txt" })(facts({ workspace })),
    ).toMatchObject({ passed: true });
  });

  it("checks which tools were used", async () => {
    const events = [toolEnd("read_file"), toolEnd("edit_file")];

    expect(
      await createGrader({ type: "used-tool", name: "edit_file" })(facts({ events })),
    ).toMatchObject({ passed: true });

    const forbidden = await createGrader({
      type: "not-used-tool",
      name: "edit_file",
    })(facts({ events }));
    expect(forbidden.passed).toBe(false);
    expect(forbidden.reason).toContain("1 time(s)");

    const missing = await createGrader({ type: "used-tool", name: "search_text" })(
      facts({ events }),
    );
    // The failure names what was called instead, so the fix is obvious.
    expect(missing.reason).toContain("read_file, edit_file");
  });

  it("distinguishes a failed tool call from a successful one", async () => {
    const events = [toolEnd("bash", true)];

    expect(
      await createGrader({ type: "used-tool", name: "bash" })(facts({ events })),
    ).toMatchObject({ passed: true });
    expect(
      await createGrader({ type: "tool-succeeded", name: "bash" })(facts({ events })),
    ).toMatchObject({ passed: false });
  });

  it("matches and excludes answers", async () => {
    const attempt = facts({ finalAnswer: "The file does not exist." });

    expect(
      await createGrader({ type: "answer-matches", pattern: "does not exist" })(attempt),
    ).toMatchObject({ passed: true });
    expect(
      await createGrader({ type: "answer-excludes", pattern: "does not exist" })(attempt),
    ).toMatchObject({ passed: false });
  });

  it("limits turns", async () => {
    expect(
      await createGrader({ type: "max-turns-under", turns: 3 })(facts({ turnCount: 5 })),
    ).toMatchObject({ passed: false });
    expect(
      await createGrader({ type: "max-turns-under", turns: 5 })(facts({ turnCount: 5 })),
    ).toMatchObject({ passed: true });
  });

  it("refuses an unknown grader type and lists the known ones", () => {
    expect(() => createGrader({ type: "vibes" })).toThrow(/Unknown grader type/);
    expect(GRADER_TYPES).toContain("file-contains");
  });

  it("refuses a grader missing its arguments", () => {
    expect(() => createGrader({ type: "file-contains", path: "a" })).toThrow(/text/);
    expect(() => createGrader({ type: "max-turns-under" })).toThrow(/turns/);
  });
});

describe("fixture isolation", () => {
  it("gives each attempt its own copy", async () => {
    const fixture = await temporaryDirectory();
    await writeFile(path.join(fixture, "a.txt"), "original");

    const first = await createAttemptWorkspace(fixture);
    await writeFile(path.join(first.path, "a.txt"), "clobbered");
    const second = await createAttemptWorkspace(fixture);

    // The second attempt must not see what the first one did.
    expect(await readFile(path.join(second.path, "a.txt"), "utf8")).toBe("original");
    await first.dispose();
    await second.dispose();
  });

  it("works for a task with no fixture at all", async () => {
    const workspace = await createAttemptWorkspace("/does/not/exist");

    expect(workspace.path.length).toBeGreaterThan(0);
    await workspace.dispose();
  });
});

describe("runner", () => {
  /** Hands out a different scripted client per attempt, so runs can differ. */
  function clientSequence(responses: readonly (readonly LLMResponse[])[]) {
    let index = 0;
    return () => {
      const script = responses[Math.min(index, responses.length - 1)] ?? [];
      index += 1;
      return new FakeLLMClient(script);
    };
  }

  const baseOptions = {
    systemPrompt: "system",
    capabilities: [] as const,
  };

  it("reports a pass rate rather than a verdict", async () => {
    const root = await temporaryDirectory();
    const directory = await writeTask(
      root,
      "answer",
      {
        name: "answer",
        prompt: "what is it",
        attempts: 3,
        graders: [{ type: "answer-matches", pattern: "^right$" }],
      },
    );
    const task = await loadTask(directory);

    const result = await runTask(task, {
      ...baseOptions,
      // Attempt 2 gets it wrong: a task's outcome is a rate, not a verdict.
      createClient: clientSequence([
        [assistant("right")],
        [assistant("wrong")],
        [assistant("right")],
      ]),
    });

    expect(result.passed).toBe(2);
    expect(result.total).toBe(3);
    expect(result.attempts.map((attempt) => attempt.passed)).toEqual([true, false, true]);
  });

  it("records why each attempt failed", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(root, "answer", {
        name: "answer",
        prompt: "what is it",
        attempts: 1,
        graders: [{ type: "answer-matches", pattern: "^right$" }],
      }),
    );

    const result = await runTask(task, {
      ...baseOptions,
      createClient: clientSequence([[assistant("nope")]]),
    });

    expect(result.attempts[0]?.failures[0]).toContain("did not match");
    expect(result.attempts[0]?.failures[0]).toContain("nope");
  });

  it("counts a run that hits the turn limit as a failure with a reason", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(root, "loop", {
        name: "loop",
        prompt: "go",
        attempts: 1,
        maxTurns: 2,
        graders: [{ type: "answer-matches", pattern: "done" }],
      }),
    );

    // An assistant message with a tool call never terminates the loop.
    const spin = assistant("", [{ id: "c1", name: "list_files", arguments: {} }]);
    const result = await runTask(task, {
      ...baseOptions,
      createClient: () =>
        new FakeLLMClient([
          spin,
          { ...spin, message: { ...spin.message, toolCalls: [{ id: "c2", name: "list_files", arguments: {} }] } },
        ]),
    });

    expect(result.passed).toBe(0);
    expect(result.attempts[0]?.status).toBe("max_turns");
    expect(result.attempts[0]?.failures[0]).toContain("2-turn limit");
  });

  it("treats a crashed run as one failed attempt, not a failed eval", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(root, "boom", {
        name: "boom",
        prompt: "go",
        attempts: 2,
        graders: [{ type: "answer-matches", pattern: "ok" }],
      }),
    );

    let call = 0;
    const result = await runTask(task, {
      ...baseOptions,
      createClient: () => {
        call += 1;
        // The first attempt has no scripted response and throws inside the run.
        return new FakeLLMClient(call === 1 ? [] : [assistant("ok")]);
      },
    });

    expect(result.attempts[0]).toMatchObject({ passed: false, status: "error" });
    expect(result.attempts[1]).toMatchObject({ passed: true });
    expect(result.passed).toBe(1);
  });

  it("refuses a task whose capabilities were not granted", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(root, "writes", {
        name: "writes",
        prompt: "edit it",
        capabilities: ["writes"],
        graders: [{ type: "file-exists", path: "a.txt" }],
      }),
    );

    await expect(
      runTask(task, { ...baseOptions, createClient: () => new FakeLLMClient([]) }),
    ).rejects.toBeInstanceOf(MissingCapabilityError);
    // The message says how to fix it rather than only what is wrong.
    await expect(
      runTask(task, { ...baseOptions, createClient: () => new FakeLLMClient([]) }),
    ).rejects.toThrow(/--allow-writes/);
  });

  it("grades the workspace the attempt actually left behind", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(
        root,
        "rename",
        {
          name: "rename",
          prompt: "rename it",
          capabilities: ["writes"],
          attempts: 1,
          graders: [
            { type: "file-contains", path: "greet.ts", text: "greet" },
            { type: "file-excludes", path: "greet.ts", text: "sayHi" },
            { type: "used-tool", name: "edit_file" },
          ],
        },
        { "greet.ts": "export function sayHi() {}\n" },
      ),
    );

    const result = await runTask(task, {
      systemPrompt: "system",
      capabilities: ["writes"],
      createClient: () =>
        new FakeLLMClient([
          assistant("", [
            {
              id: "c1",
              name: "edit_file",
              arguments: { path: "greet.ts", old_text: "sayHi", new_text: "greet" },
            },
          ]),
          assistant("renamed"),
        ]),
    });

    expect(result.attempts[0]?.failures).toEqual([]);
    expect(result.passed).toBe(1);
  });

  it("fails a task that reached the right result with the wrong tool", async () => {
    const root = await temporaryDirectory();
    const task = await loadTask(
      await writeTask(
        root,
        "rename",
        {
          name: "rename",
          prompt: "rename it",
          capabilities: ["writes"],
          attempts: 1,
          graders: [
            { type: "file-contains", path: "greet.ts", text: "greet" },
            { type: "not-used-tool", name: "write_file" },
          ],
        },
        { "greet.ts": "export function sayHi() {}\n" },
      ),
    );

    const result = await runTask(task, {
      systemPrompt: "system",
      capabilities: ["writes"],
      createClient: () =>
        new FakeLLMClient([
          assistant("", [
            {
              id: "c1",
              name: "write_file",
              arguments: { path: "greet.ts", contents: "export function greet() {}\n" },
            },
          ]),
          assistant("renamed"),
        ]),
    });

    // The contents are right; the method was not. Outcome-only grading would
    // have given this full marks.
    expect(result.passed).toBe(0);
    expect(result.attempts[0]?.failures[0]).toContain("write_file");
  });
});

describe("report", () => {
  const results = [
    {
      task: "alpha",
      total: 2,
      passed: 1,
      attempts: [
        { attempt: 1, passed: true, status: "completed" as const, turnCount: 2, durationMs: 1000, toolsUsed: ["read_file"], failures: [] },
        { attempt: 2, passed: false, status: "completed" as const, turnCount: 4, durationMs: 3000, toolsUsed: ["read_file"], failures: ["used-tool name=\"edit_file\" — never called edit_file"] },
      ],
    },
  ];

  it("shows the sample size beside the score", () => {
    const table = formatTable(results);

    expect(table).toContain("1/2");
    expect(table).toContain("overall  1/2 (50%)");
    expect(table).toContain("read_file");
  });

  it("says there were no tasks rather than printing an empty table", () => {
    expect(formatTable([])).toBe("No tasks ran.\n");
  });

  it("groups a repeated failure into one line", () => {
    const repeated = [
      {
        ...results[0]!,
        attempts: results[0]!.attempts.map((attempt) => ({
          ...attempt,
          passed: false,
          failures: ["same reason"],
        })),
      },
    ];

    expect(formatFailures(repeated)).toBe("alpha attempt 1,2: same reason\n");
  });

  it("produces a JSON report with rates and per-attempt detail", () => {
    const json = toJsonReport(results, {
      provider: "openai",
      model: "gpt-5.6",
      version: "0.13.0",
      startedAt: "2026-09-06T00:00:00.000Z",
    }) as Record<string, any>;

    expect(json.schemaVersion).toBe(1);
    expect(json.tasks[0].passRate).toBe(0.5);
    expect(json.tasks[0].attempts).toHaveLength(2);
    expect(json.overall).toEqual({ passed: 1, total: 2, totalTokens: 0 });
  });
});

describe("the eval tasks that ship with chivgent", () => {
  it("all parse, and every grader they declare can be constructed", async () => {
    // A typo in a task.json should surface here, not after paying a provider
    // for a run that was never going to grade correctly.
    const tasks = await loadTasks(path.join(process.cwd(), "evals"));

    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      for (const spec of task.graders) {
        expect(() => createGrader(spec)).not.toThrow();
      }
    }
  });

  it("declares the capabilities its graders imply", async () => {
    const tasks = await loadTasks(path.join(process.cwd(), "evals"));

    for (const task of tasks) {
      const usesWriteTool = task.graders.some(
        (spec) =>
          (spec.type === "used-tool" || spec.type === "tool-succeeded") &&
          (spec.name === "edit_file" || spec.name === "write_file"),
      );
      const usesShell = task.graders.some(
        (spec) =>
          (spec.type === "used-tool" || spec.type === "tool-succeeded") &&
          spec.name === "bash",
      );
      if (usesWriteTool) {
        expect(task.capabilities).toContain("writes");
      }
      if (usesShell) {
        expect(task.capabilities).toContain("shell");
      }
    }
  });
});

describe("eval CLI arguments", () => {
  it("defaults to every task in evals/", () => {
    const options = parseEvalArgs([]);

    expect(options.tasks).toEqual([]);
    expect(options.directory).toBe("evals");
    expect(options.capabilities).toEqual([]);
  });

  it("collects repeated --task flags", () => {
    expect(parseEvalArgs(["--task", "a", "--task", "b"]).tasks).toEqual(["a", "b"]);
  });

  it("passes provider selection through untouched", () => {
    const options = parseEvalArgs(["--provider", "deepseek", "--model", "x"]);

    expect(options.providerArgs).toEqual(["--provider", "deepseek", "--model", "x"]);
  });

  it("grants capabilities explicitly", () => {
    const options = parseEvalArgs(["--allow-writes", "--allow-shell"]);

    expect(options.capabilities).toEqual(["writes", "shell"]);
  });

  it("rejects a nonsensical attempt count and unknown options", () => {
    expect(() => parseEvalArgs(["--attempts", "0"])).toThrow(/--attempts/);
    expect(() => parseEvalArgs(["--attempts"])).toThrow(/requires a value/);
    expect(() => parseEvalArgs(["--wat"])).toThrow(/Unknown option/);
  });
});
