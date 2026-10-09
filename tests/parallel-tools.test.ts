import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { ListFilesTool } from "../src/tools/list-files.js";
import { SearchTextTool } from "../src/tools/search-text.js";
import { EditFileTool } from "../src/tools/edit-file.js";
import { isParallelReadTool, MAX_PARALLEL_READS } from "../src/tools/parallel.js";
import type { Tool } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function awaitGate(promise: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("parallel tools did not start together")), 3_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function slice(path: string) {
  return {
    content: `contents of ${path}\n`,
    startLine: 1, endLine: 1, totalLines: 1, truncated: false,
  };
}

function makeWorkspace(read: Workspace["readTextFile"]): Workspace {
  return {
    root: "/workspace",
    ...readOnlyWorkspaceWrites,
    readTextFile: read,
    async listFiles() { return { entries: [], truncated: false }; },
    async searchText() { return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
  };
}

function makeAgent(llm: FakeLLMClient, workspace: Workspace, tools: readonly Tool[], events?: AgentEvent[]): Agent {
  return new Agent({
    systemPrompt: "test",
    maxTurns: 4,
    llm,
    workspace,
    tools,
    streaming: false,
    ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
  });
}

const readCall = (id: string) => ({ id, name: "read_file", arguments: { path: `${id}.ts` } });

describe("parallel built-in read tool scheduling", () => {
  it("overlaps reads and commits tool messages in call order, not completion order", async () => {
    const first = deferred();
    const second = deferred();
    const bothStarted = deferred();
    const secondFinished = deferred();
    const started: string[] = [];
    const finished: string[] = [];
    const workspace = makeWorkspace(async file => {
      started.push(file);
      if (started.length === 2) bothStarted.resolve();
      await (file === "first.ts" ? first.promise : second.promise);
      finished.push(file);
      if (file === "second.ts") secondFinished.resolve();
      return slice(file);
    });
    const llm = new FakeLLMClient([
      assistant("", [readCall("first"), readCall("second")]),
      assistant("done"),
    ]);
    const events: AgentEvent[] = [];
    const run = makeAgent(llm, workspace, [new ReadFileTool()], events).run("read both");
    await awaitGate(bothStarted.promise);
    expect(started).toEqual(["first.ts", "second.ts"]);

    second.resolve();
    await awaitGate(secondFinished.promise);
    first.resolve();
    const result = await run;

    expect(result.status).toBe("completed");
    expect(finished).toEqual(["second.ts", "first.ts"]);
    expect(result.messages.filter(message => message.role === "tool")
      .map(message => message.toolCallId)).toEqual(["first", "second"]);
    expect(llm.requests[1]?.messages.filter(message => message.role === "tool")
      .map(message => message.toolCallId)).toEqual(["first", "second"]);
    expect(events.filter(event => event.type === "turn_end")[0]).toMatchObject({
      toolResults: [{ toolCallId: "first" }, { toolCallId: "second" }],
    });
  });

  it("runs three different built-in readonly tools in the same wave", async () => {
    const gate = deferred();
    const started = deferred();
    const active: string[] = [];
    const record = async (name: string) => {
      active.push(name);
      if (active.length === 3) started.resolve();
      await gate.promise;
    };
    const workspace: Workspace = {
      ...makeWorkspace(async file => { await record("read"); return slice(file); }),
      async listFiles() { await record("list"); return { entries: [], truncated: false }; },
      async searchText() { await record("search"); return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 }; },
    };
    const llm = new FakeLLMClient([
      assistant("", [
        readCall("a"),
        { id: "b", name: "list_files", arguments: { path: "." } },
        { id: "c", name: "search_text", arguments: { query: "x", path: "." } },
      ]),
      assistant("done"),
    ]);
    const run = makeAgent(llm, workspace, [
      new ReadFileTool(), new ListFilesTool(), new SearchTextTool(),
    ]).run("explore");
    await awaitGate(started.promise);
    expect(active).toEqual(["read", "list", "search"]);
    gate.resolve();
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.messages.filter(m => m.role === "tool").map(m => m.toolCallId))
      .toEqual(["a", "b", "c"]);
  });

  it("places an exclusive barrier before and after every write", async () => {
    const initialReads = deferred();
    const releaseReads = deferred();
    const startedWrite = deferred();
    const releaseWrite = deferred();
    const log: string[] = [];
    const workspace: Workspace = {
      ...makeWorkspace(async file => {
        log.push(`read:${file}`);
        if (file === "two.ts") initialReads.resolve();
        if (file !== "three.ts") await releaseReads.promise;
        return slice(file);
      }),
      async editTextFile(file) {
        log.push("write");
        startedWrite.resolve();
        await releaseWrite.promise;
        return { path: file, line: 1, totalLines: 1, bytesWritten: 4 };
      },
    };
    const llm = new FakeLLMClient([
      assistant("", [
        readCall("one"), readCall("two"),
        { id: "edit", name: "edit_file", arguments: { path: "one.ts", old_text: "x", new_text: "y" } },
        readCall("three"),
      ]),
      assistant("done"),
    ]);
    const run = makeAgent(llm, workspace, [new ReadFileTool(), new EditFileTool()]).run("edit one");
    await awaitGate(initialReads.promise);
    expect(log).toEqual(["read:one.ts", "read:two.ts"]);
    releaseReads.resolve();
    await awaitGate(startedWrite.promise);
    expect(log).not.toContain("read:three.ts");
    releaseWrite.resolve();
    const result = await run;
    expect(result.status).toBe("completed");
    expect(log).toEqual(["read:one.ts", "read:two.ts", "write", "read:three.ts"]);
    expect(result.messages.filter(m => m.role === "tool").map(m => m.toolCallId))
      .toEqual(["one", "two", "edit", "three"]);
  });

  it("never exceeds the parallel read cap, even for a large tool-call batch", async () => {
    let active = 0;
    let peak = 0;
    let began = 0;
    const gate = deferred();
    const firstWave = deferred();
    const workspace = makeWorkspace(async file => {
      active += 1;
      began += 1;
      peak = Math.max(peak, active);
      if (began === MAX_PARALLEL_READS) firstWave.resolve();
      await gate.promise;
      active -= 1;
      return slice(file);
    });
    const llm = new FakeLLMClient([
      assistant("", Array.from({ length: 11 }, (_, index) => readCall(`f${index}`))),
      assistant("done"),
    ]);
    const run = makeAgent(llm, workspace, [new ReadFileTool()]).run("read eleven");
    await awaitGate(firstWave.promise);
    expect(began).toBe(MAX_PARALLEL_READS);
    expect(peak).toBe(MAX_PARALLEL_READS);
    gate.resolve();
    const result = await run;
    expect(result.status).toBe("completed");
    expect(began).toBe(11);
    expect(peak).toBe(MAX_PARALLEL_READS);
  });

  it("never trusts a custom extension that merely calls itself read_file", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let started = 0;
    const extension: Tool = {
      name: "read_file",
      description: "custom extension, not a built-in",
      inputSchema: { type: "object" },
      async execute() {
        started += 1;
        if (started === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { content: "extension", isError: false };
      },
    };
    expect(isParallelReadTool(extension)).toBe(false);
    const llm = new FakeLLMClient([
      assistant("", [readCall("one"), readCall("two")]),
      assistant("done"),
    ]);
    const run = makeAgent(llm, makeWorkspace(async file => slice(file)), [extension]).run("use extension");
    await awaitGate(firstStarted.promise);
    expect(started).toBe(1);
    releaseFirst.resolve();
    const result = await run;
    expect(started).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("returns per-call errors without cancelling independent reads", async () => {
    const llm = new FakeLLMClient([
      assistant("", [readCall("bad"), readCall("good")]),
      assistant("recovered"),
    ]);
    const workspace = makeWorkspace(async file => {
      if (file === "bad.ts") throw new Error("sensitive file system details");
      return slice(file);
    });
    const result = await makeAgent(llm, workspace, [new ReadFileTool()]).run("read both");
    expect(result.status).toBe("completed");
    const outputs = result.messages.filter(m => m.role === "tool");
    expect(outputs.map(m => m.toolCallId)).toEqual(["bad", "good"]);
    expect(outputs[0]).toMatchObject({ isError: true, content: "Tool execution failed: read_file" });
    expect(outputs[1]).toMatchObject({ isError: false });
  });

  it("drains already-started reads before persisting an interrupted run", async () => {
    const started = deferred();
    const fail = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let began = 0;
    const workspace = makeWorkspace(async file => {
      began += 1;
      if (began === 2) started.resolve();
      if (file === "first.ts") {
        await fail.promise;
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      await finish.promise;
      return slice(file);
    });
    const llm = new FakeLLMClient([
      assistant("", [readCall("first"), readCall("second")]),
    ]);
    const run = makeAgent(llm, workspace, [new ReadFileTool()], events)
      .run("read both", { signal: controller.signal });
    await awaitGate(started.promise);
    controller.abort();
    finish.resolve();
    fail.resolve();
    const result = await run;
    expect(result.status).toBe("aborted");
    const outputs = result.messages.filter(m => m.role === "tool");
    expect(outputs.map(m => m.toolCallId)).toEqual(["first", "second"]);
    expect(outputs[0]).toMatchObject({
      isError: true, content: "Tool execution interrupted before completion.",
    });
    expect(outputs[1]).toMatchObject({ isError: false });
    expect(events.at(-1)).toMatchObject({ type: "agent_end", status: "aborted" });
    const endIndex = events.findIndex(event => event.type === "agent_end");
    expect(events.slice(endIndex + 1)).toEqual([]);
    expect(llm.requests).toHaveLength(1);
  });
});
