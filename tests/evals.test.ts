import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrader, GRADER_TYPES } from "../src/evals/graders.js";
import type { AttemptFacts } from "../src/evals/graders.js";
import { createAttemptWorkspace } from "../src/evals/fixture.js";
import { loadTask, loadTasks, parseTask, TaskError } from "../src/evals/task.js";
import { parseEvalArgs } from "../src/evals/parse-args.js";
import { toolNamesFor, toolsFor } from "../src/evals/tools.js";
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
    fixtureDirectory: "/nowhere",
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

  it("catches a guessed path through the tool call that failed", async () => {
    // The whole point: a deduplicated set of tool names cannot tell a model
    // that guessed and recovered from one that never guessed.
    const guessed = createGrader({ type: "tool-never-failed", name: "read_file" });

    const failure = await guessed(
      facts({ events: [toolEnd("read_file", true), toolEnd("read_file")] }),
    );
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain("read_file failed 1 time(s)");

    expect(
      await guessed(facts({ events: [toolEnd("read_file"), toolEnd("list_files")] })),
    ).toMatchObject({ passed: true });
  });

  it("ignores another tool's failures", async () => {
    expect(
      await createGrader({ type: "tool-never-failed", name: "read_file" })(
        facts({ events: [toolEnd("bash", true)] }),
      ),
    ).toMatchObject({ passed: true });
  });

  it("compares an untouched file against the fixture, not against a copy", async () => {
    const fixtureDirectory = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    await writeFile(path.join(fixtureDirectory, "decoy.ts"), "a\nb\nc\n");
    await writeFile(path.join(workspace, "decoy.ts"), "a\nb\nc\n");

    const grader = createGrader({ type: "file-unchanged", path: "decoy.ts" });
    expect(await grader(facts({ workspace, fixtureDirectory }))).toMatchObject({
      passed: true,
    });

    await writeFile(path.join(workspace, "decoy.ts"), "a\nB\nc\n");
    const failure = await grader(facts({ workspace, fixtureDirectory }));
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain("line 2");
  });

  it("counts a deleted file as changed", async () => {
    const fixtureDirectory = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    await writeFile(path.join(fixtureDirectory, "decoy.ts"), "a\n");

    const failure = await createGrader({ type: "file-unchanged", path: "decoy.ts" })(
      facts({ workspace, fixtureDirectory }),
    );
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain("deleted");
  });

  it("refuses to grade a file that is not in the fixture", async () => {
    // Silently passing would make the grader look like it was checking.
    const fixtureDirectory = await temporaryDirectory();
    const workspace = await temporaryDirectory();

    await expect(
      createGrader({ type: "file-unchanged", path: "typo.ts" })(
        facts({ workspace, fixtureDirectory }),
      ),
    ).rejects.toThrow(/not in the fixture/);
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

  it("records every tool call in order, with whether it succeeded", async () => {
    const root = await temporaryDirectory();
    const directory = await writeTask(root, "trace", {
      name: "trace",
      prompt: "read things",
      attempts: 1,
      graders: [{ type: "answer-matches", pattern: "done" }],
    });
    await writeFile(path.join(directory, "fixture", "real.ts"), "export const a = 1;\n");
    const task = await loadTask(directory);

    const result = await runTask(task, {
      ...baseOptions,
      createClient: clientSequence([
        [
          // A guessed path, then a recovery. Both land in the same set.
          assistant("", [
            { id: "1", name: "read_file", arguments: { path: "guessed.ts" } },
          ]),
          assistant("", [
            { id: "2", name: "read_file", arguments: { path: "real.ts" } },
          ]),
          assistant("done"),
        ],
      ]),
    });

    expect(result.attempts[0]?.toolCalls).toEqual([
      { name: "read_file", ok: false },
      { name: "read_file", ok: true },
    ]);
    // The set the table uses cannot distinguish this from a clean run, which
    // is why the ordered list exists alongside it.
    expect(result.attempts[0]?.toolsUsed).toEqual(["read_file"]);
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
        { attempt: 1, passed: true, status: "completed" as const, turnCount: 2, durationMs: 1000, toolsUsed: ["read_file"], toolCalls: [{ name: "read_file", ok: true }], failures: [] },
        { attempt: 2, passed: false, status: "completed" as const, turnCount: 4, durationMs: 3000, toolsUsed: ["read_file"], toolCalls: [{ name: "read_file", ok: false }, { name: "read_file", ok: true }], failures: ["used-tool name=\"edit_file\" — never called edit_file"] },
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

describe("the new tasks, driven by a scripted model", () => {
  // A grader that has never been seen to fail is worth as little as the
  // vacuous one this stage removed. Each task is run twice: once down the
  // path it is meant to reward, once down the mistake it exists to catch.
  const shipped = (name: string) =>
    loadTask(path.join(process.cwd(), "evals", name));

  async function run(
    name: string,
    capabilities: readonly ("writes" | "shell")[],
    script: readonly LLMResponse[],
  ) {
    const task = await shipped(name);
    const result = await runTask(task, {
      systemPrompt: "system",
      capabilities,
      attempts: 1,
      createClient: () => new FakeLLMClient([...script]),
    });
    return result.attempts[0];
  }

  it("decoy-config rewards editing the module the entry point imports", async () => {
    const attempt = await run("decoy-config", ["writes"], [
      assistant("", [
        { id: "1", name: "read_file", arguments: { path: "src/index.ts" } },
      ]),
      assistant("", [
        {
          id: "2",
          name: "edit_file",
          arguments: {
            path: "src/settings/http.ts",
            old_text: "timeoutSeconds: 30",
            new_text: "timeoutSeconds: 60",
          },
        },
      ]),
      assistant("Changed the timeout in src/settings/http.ts."),
    ]);

    expect(attempt?.failures).toEqual([]);
  });

  it("decoy-config catches the model that edited the dead module", async () => {
    const attempt = await run("decoy-config", ["writes"], [
      assistant("", [
        {
          id: "1",
          name: "edit_file",
          arguments: {
            path: "src/config/http.ts",
            old_text: "timeoutSeconds: 30",
            new_text: "timeoutSeconds: 60",
          },
        },
      ]),
      assistant("Changed the timeout."),
    ]);

    expect(attempt?.passed).toBe(false);
    expect(attempt?.failures.join("\n")).toContain("src/config/http.ts was modified");
    expect(attempt?.failures.join("\n")).toContain("src/settings/http.ts");
  });

  it("wrong-test rewards fixing the test that contradicts the contract", async () => {
    const attempt = await run("wrong-test", ["writes", "shell"], [
      assistant("", [
        { id: "1", name: "bash", arguments: { command: "node test.js" } },
      ]),
      assistant("", [
        {
          id: "2",
          name: "edit_file",
          arguments: {
            path: "test.js",
            old_text: '"--hello---world--"',
            new_text: '"hello-world"',
          },
        },
      ]),
      assistant("The test contradicted the documented contract; fixed the test."),
    ]);

    expect(attempt?.failures).toEqual([]);
  });

  it("wrong-test catches the model that bent the source to fit the test", async () => {
    const attempt = await run("wrong-test", ["writes", "shell"], [
      assistant("", [
        { id: "1", name: "bash", arguments: { command: "node test.js" } },
      ]),
      assistant("", [
        {
          id: "2",
          name: "edit_file",
          arguments: {
            path: "slug.js",
            old_text: "title.trim()",
            new_text: "title",
          },
        },
      ]),
      assistant("Fixed the source."),
    ]);

    expect(attempt?.passed).toBe(false);
    expect(attempt?.failures.join("\n")).toContain("slug.js was modified");
  });

  it("needle-in-many-files rewards searching over guessing", async () => {
    const attempt = await run("needle-in-many-files", [], [
      assistant("", [
        {
          id: "1",
          name: "search_text",
          arguments: { pattern: "computeRetryBudget" },
        },
      ]),
      assistant(
        "src/module23.ts defines it; it multiplies attempts by baseDelayMs and doubles the result.",
      ),
    ]);

    expect(attempt?.failures).toEqual([]);
  });

  it("needle-in-many-files catches the model that read its way there", async () => {
    // Right answer, wrong method — and the guessed reads show up as failures.
    const attempt = await run("needle-in-many-files", [], [
      assistant("", [
        { id: "1", name: "read_file", arguments: { path: "src/retry.ts" } },
      ]),
      assistant("", [
        { id: "2", name: "read_file", arguments: { path: "src/module23.ts" } },
      ]),
      assistant(
        "src/module23.ts defines it; it multiplies attempts by baseDelayMs and doubles the result.",
      ),
    ]);

    expect(attempt?.passed).toBe(false);
    const reasons = attempt?.failures.join("\n") ?? "";
    expect(reasons).toContain("never called search_text");
    expect(reasons).toContain("read_file failed 1 time(s)");
  });

  it("trace-the-default catches the model that stopped at the first hop", async () => {
    const attempt = await run("trace-the-default", [], [
      assistant("", [
        { id: "1", name: "read_file", arguments: { path: "src/client.ts" } },
      ]),
      assistant("It uses the default of 5000 ms, set in src/defaults.ts."),
    ]);

    expect(attempt?.passed).toBe(false);
    expect(attempt?.failures.join("\n")).toContain("30[,. ]?000");
  });

  it("trace-the-default accepts the answer that followed the override", async () => {
    const attempt = await run("trace-the-default", [], [
      assistant("", [
        { id: "1", name: "read_file", arguments: { path: "src/app.ts" } },
      ]),
      assistant(
        "In production it uses 30000 ms, defined as PRODUCTION_TIMEOUT_MS in src/env.ts.",
      ),
    ]);

    expect(attempt?.failures).toEqual([]);
  });
});

describe("the tool list a task's capabilities grant", () => {
  const combinations: (readonly ("writes" | "shell")[])[] = [
    [],
    ["writes"],
    ["shell"],
    ["writes", "shell"],
  ];

  it("names exactly the tools the runner builds", () => {
    // The two lists exist separately because one needs a cwd and the other is
    // consulted before any workspace exists. This is what stops them drifting.
    for (const capabilities of combinations) {
      expect(toolNamesFor(capabilities)).toEqual(
        toolsFor(capabilities, "/nowhere").map((tool) => tool.name),
      );
    }
  });

  it("refuses a grader that forbids a tool the task never grants", () => {
    // The assertion would be vacuously true: the model cannot call what it was
    // never given, so the grader reads like a check and is worth nothing.
    expect(() =>
      parseTask(
        {
          prompt: "p",
          capabilities: [],
          graders: [{ type: "not-used-tool", name: "write_file" }],
        },
        "/tasks/t",
        "/tasks/t/fixture",
      ),
    ).toThrow(/never grants/);
  });

  it("refuses a grader that requires a tool the task never grants", () => {
    // The mirror image: this one can never pass, so every attempt scores zero
    // for a reason that has nothing to do with the model.
    expect(() =>
      parseTask(
        {
          prompt: "p",
          capabilities: [],
          graders: [{ type: "used-tool", name: "bash" }],
        },
        "/tasks/t",
        "/tasks/t/fixture",
      ),
    ).toThrow(/never grants/);
  });

  it("names the task and the grader so the fix is obvious", () => {
    expect(() =>
      parseTask(
        {
          name: "my-task",
          prompt: "p",
          capabilities: ["writes"],
          graders: [
            { type: "used-tool", name: "read_file" },
            { type: "tool-never-failed", name: "bash" },
          ],
        },
        "/tasks/t",
        "/tasks/t/fixture",
      ),
    ).toThrow(/my-task: graders\[1\] \(tool-never-failed\)/);
  });

  it("leaves graders that name no tool alone", () => {
    expect(() =>
      parseTask(
        {
          prompt: "p",
          capabilities: [],
          graders: [{ type: "file-contains", path: "a.ts", text: "x" }],
        },
        "/tasks/t",
        "/tasks/t/fixture",
      ),
    ).not.toThrow();
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

  it("accepts the refusal wording that the first real baseline rejected", async () => {
    // Verbatim from docs/eval-baseline-2026-09.md: the model was right, and
    // the grader was the thing that failed. Pinned so the pattern cannot
    // narrow back.
    const task = await loadTask(
      path.join(process.cwd(), "evals", "no-hallucinated-read"),
    );
    const answer =
      "There is no `src/database/migrations.ts` in this project — in fact, there is no `src/database/` directory at all.";

    for (const spec of task.graders) {
      expect(await createGrader(spec)(facts({ finalAnswer: answer }))).toMatchObject(
        { passed: true },
      );
    }
  });

  it("declares the capabilities its graders imply", async () => {
    // Superseded as a hand-written check by the loader's own validation, which
    // covers every tool rather than the three this used to name. What is left
    // here is the end-to-end assertion that the shipped tasks satisfy it.
    const tasks = await loadTasks(path.join(process.cwd(), "evals"));

    for (const task of tasks) {
      const named = task.graders
        .filter((spec) => typeof spec.name === "string")
        .map((spec) => spec.name as string);
      for (const tool of named) {
        expect(toolNamesFor(task.capabilities)).toContain(tool);
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

  it("passes a key through so an ephemeral machine can supply one", () => {
    // The credential chain names --api-key the highest-priority source, and
    // the no-credential error tells the user to pass it; the eval runner used
    // to reject it, which made that advice wrong under npm run eval.
    const options = parseEvalArgs(["--provider", "deepseek", "--api-key", "sk-x"]);

    expect(options.providerArgs).toEqual([
      "--provider",
      "deepseek",
      "--api-key",
      "sk-x",
    ]);
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
