import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBaselineManifest, describeSuite } from "../src/evals/baseline.js";
import { loadTask, TaskError } from "../src/evals/task.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function taskFixture(name = "demo") {
  const home = await mkdtemp(path.join(tmpdir(), "chivgent-baseline-"));
  homes.push(home);
  const directory = path.join(home, name);
  const fixture = path.join(directory, "fixture");
  await mkdir(fixture, { recursive: true });
  await writeFile(path.join(directory, "task.json"), JSON.stringify({
    name,
    prompt: "Read a.txt",
    graders: [{ type: "answer-matches", pattern: "ok" }],
  }));
  await writeFile(path.join(fixture, "a.txt"), "one\n");
  return { directory, fixture, task: await loadTask(directory) };
}

describe("eval baseline preflight", () => {
  it("uses identical hashes for identical task contents in different paths", async () => {
    const a = await taskFixture();
    const b = await taskFixture();
    const one = await describeSuite([a.task]);
    const two = await describeSuite([b.task]);
    expect(one).toEqual(two);
    expect(one.suiteSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects fixture mutations and task definition changes", async () => {
    const a = await taskFixture();
    const before = await describeSuite([a.task]);
    await writeFile(path.join(a.fixture, "a.txt"), "two\n");
    const afterFixture = await describeSuite([a.task]);
    expect(afterFixture.suiteSha256).not.toBe(before.suiteSha256);
    await writeFile(path.join(a.directory, "task.json"), JSON.stringify({
      name: "demo", prompt: "Another question",
      graders: [{ type: "answer-matches", pattern: "ok" }],
    }));
    const afterTask = await describeSuite([await loadTask(a.directory)]);
    expect(afterTask.suiteSha256).not.toBe(afterFixture.suiteSha256);
  });

  it("rejects broken grader configuration before reaching a model", async () => {
    const a = await taskFixture();
    await writeFile(path.join(a.directory, "task.json"), JSON.stringify({
      name: "demo", prompt: "Read a.txt",
      graders: [{ type: "file-contains", path: "a.txt" }],
    }));
    await expect(describeSuite([await loadTask(a.directory)])).rejects.toThrow(/invalid file-contains/);
  });

  it("rejects a file-unchanged grader whose reference fixture is absent", async () => {
    const a = await taskFixture();
    await writeFile(path.join(a.directory, "task.json"), JSON.stringify({
      name: "demo", prompt: "Read a.txt",
      graders: [{ type: "file-unchanged", path: "missing.txt" }],
    }));
    await expect(describeSuite([await loadTask(a.directory)])).rejects.toBeInstanceOf(TaskError);
  });

  it("exposes skipped tasks and does not include secrets in metadata", async () => {
    const suite = { suiteSha256: "abc", tasks: [
      { name: "read", sha256: "one", attempts: 5, maxTurns: 12, capabilities: [] },
      { name: "write", sha256: "two", attempts: 5, maxTurns: 12, capabilities: ["writes" as const] },
    ] };
    const manifest = buildBaselineManifest(suite, { revision: null, dirty: null }, {
      provider: "openai", model: "model", capabilities: [], systemPrompts: ["test"],
    });
    expect(manifest.attemptedTasks).toEqual(["read"]);
    expect(manifest.skippedTasks).toEqual(["write"]);
    expect(JSON.stringify(manifest)).not.toContain("apiKey");
  });
});
