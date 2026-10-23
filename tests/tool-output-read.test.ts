import { link, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { AgentSession } from "../src/session.js";
import { MAX_OUTPUT_FILE_BYTES, MAX_OUTPUT_SESSION_FILES, ShellOutputStore } from "../src/shell/output-store.js";
import { createLocalShellOperations } from "../src/shell/local.js";
import { MAX_OUTPUT_BUFFERED_RAW_BYTES, OutputAccumulator } from "../src/shell/output.js";
import { BashTool } from "../src/tools/bash.js";
import { ReadShellOutputTool } from "../src/tools/read-shell-output.js";
import type { ToolContext } from "../src/tools/tool.js";
import type { Workspace } from "../src/workspace.js";
import type { LLMRequest, LLMResponse } from "../src/llm.js";

const temporaryDirectories: string[] = [];
const unusedWorkspace = {} as Workspace;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-output-read-"));
  temporaryDirectories.push(directory);
  return directory;
}

const context: ToolContext = { workspace: unusedWorkspace };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function toolCall(id: string, name: string, argumentsValue: unknown) {
  return { id, name, arguments: argumentsValue };
}

describe("read shell output", () => {
  it("reads an early marker from truncated output without rerunning the command", async () => {
    const cwd = await temporaryDirectory();
    let executions = 0;
    const operations = createLocalShellOperations();
    const store = new ShellOutputStore({ tempDirectory: cwd });
    const bash = new BashTool({
      cwd,
      maxLines: 2,
      maxBytes: 1_024,
      outputStore: store,
      approve: async () => true,
      operations: {
        backend: operations.backend,
        exec: async (...args) => {
          executions += 1;
          return operations.exec(...args);
        },
      },
    });
    const reader = new ReadShellOutputTool(store);
    const first = await bash.execute(
      { command: "printf 'EARLY-ERROR-138\\n'; printf 'middle\\n'; printf 'last\\n'" },
      context,
    );

    expect(first.content).not.toContain("EARLY-ERROR-138");
    const id = /Output ID: ([0-9a-f-]+)/.exec(first.content)?.[1];
    expect(id).toBeDefined();
    expect(first.content).toContain("saved: complete");
    expect(first.shellOutput).toMatchObject({ state: "complete", totalLines: 3 });

    const result = await reader.execute({ id, startLine: 1, lineCount: 1 }, context);
    expect(result).toMatchObject({ isError: false });
    expect(result.content).toContain("EARLY-ERROR-138");
    expect(result.content).toContain("Output complete");
    expect(executions).toBe(1);

    const otherStore = new ShellOutputStore({ tempDirectory: cwd });
    const otherSession = new ReadShellOutputTool(otherStore);
    await expect(otherSession.execute({ id, startLine: 1, lineCount: 1 }, context)).resolves.toMatchObject({ isError: true });
    await store.close();
    await otherStore.close();
  });

  it("sends the saved early error into the next Provider request through the read tool", async () => {
    const cwd = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: cwd });
    const operations = createLocalShellOperations();
    let executions = 0;
    const requests: LLMRequest[] = [];
    const emittedEvents: unknown[] = [];
    const reader = new ReadShellOutputTool(store);
    const llm = {
      async complete(request: LLMRequest): Promise<LLMResponse> {
        requests.push(request);
        if (requests.length === 1) return { message: { role: "assistant", content: "", toolCalls: [toolCall("bash-1", "bash", { command: "printf 'EARLY-MODEL-MARKER\\n'; printf 'one\\ntwo\\nthree\\n'" })] } };
        if (requests.length === 2) {
          const bashResult = [...request.messages].reverse().find((message) => message.role === "tool" && message.toolName === "bash");
          const id = typeof bashResult?.content === "string" ? /Output ID: ([0-9a-f-]+)/.exec(bashResult.content)?.[1] : undefined;
          expect(id).toBeDefined();
          return { message: { role: "assistant", content: "", toolCalls: [toolCall("read-1", "read_shell_output", { id, startLine: 1, lineCount: 1 })] } };
        }
        expect(JSON.stringify(request.messages)).toContain("EARLY-MODEL-MARKER");
        return { message: { role: "assistant", content: "Found the earlier error.", toolCalls: [] } };
      },
    };
    const session = new AgentSession({
      cwd,
      agent: {
        systemPrompt: "test",
        maxTurns: 4,
        llm,
        workspace: unusedWorkspace,
        streaming: false,
        clearSessionData: () => store.clear(),
        closeSessionData: () => store.close(),
        tools: [
          new BashTool({ cwd, maxLines: 2, maxBytes: 1_024, outputStore: store, operations: { backend: operations.backend, exec: async (...args) => { executions += 1; return operations.exec(...args); } }, approve: async () => true }),
          reader,
        ],
      },
    });
    session.subscribe((event) => emittedEvents.push(event));

    const result = await session.prompt("Run the command and inspect its early error");
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(executions).toBe(1);
    const bashMessage = session.messages.find((message) => message.role === "tool" && message.toolName === "bash");
    const id = bashMessage?.role === "tool" ? bashMessage.shellOutput?.id : undefined;
    expect(id).toBeDefined();
    expect(bashMessage?.role === "tool" && bashMessage.shellOutput?.state).toBe("complete");
    expect(JSON.stringify(session.messages)).toContain('"shellOutput"');
    expect(emittedEvents).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "bash", shellOutput: { id, state: "complete", totalLines: 4 } }));

    const restoredStore = new ShellOutputStore({ tempDirectory: cwd });
    const restoredReader = new ReadShellOutputTool(restoredStore);
    const restored = new AgentSession({
      cwd,
      messages: session.messages,
      resumed: true,
      agent: {
        systemPrompt: "test",
        maxTurns: 1,
        llm: { async complete() { return { message: { role: "assistant", content: "ok", toolCalls: [] } }; } },
        workspace: unusedWorkspace,
        closeSessionData: () => restoredStore.close(),
        tools: [restoredReader],
      },
    });
    expect(restored.toolNames).toContain("read_shell_output");
    expect(restored.messages.find((message) => message.role === "tool" && message.toolName === "bash")).toMatchObject({ shellOutput: { id, state: "complete" } });
    await expect(restoredReader.execute({ id, startLine: 1, lineCount: 1 }, context)).resolves.toMatchObject({ isError: true });
    session.clear();
    await expect(reader.execute({ id, startLine: 1, lineCount: 1 }, context)).resolves.toMatchObject({ isError: true });
    await session.close();
    await restored.close();
  });

  it("copies structured shell metadata before later Provider calls can mutate it", async () => {
    const metadata = { id: "00000000-0000-4000-8000-000000000001", state: "complete" as const, totalLines: 1 };
    let calls = 0;
    const agent = new Agent({
      systemPrompt: "test",
      maxTurns: 2,
      streaming: false,
      workspace: unusedWorkspace,
      tools: [{
        name: "metadata_tool",
        description: "test typed metadata",
        inputSchema: { type: "object" },
        async execute() { return { content: "saved", isError: false, shellOutput: metadata }; },
      }],
      llm: {
        async complete(): Promise<LLMResponse> {
          calls += 1;
          if (calls === 1) return { message: { role: "assistant", content: "", toolCalls: [toolCall("metadata-1", "metadata_tool", {})] } };
          metadata.id = "00000000-0000-4000-8000-000000000002";
          return { message: { role: "assistant", content: "done", toolCalls: [] } };
        },
      },
    });
    const result = await agent.run("test metadata isolation");
    const stored = result.messages.find((message) => message.role === "tool");
    expect(stored?.role === "tool" ? stored.shellOutput?.id : undefined).toBe("00000000-0000-4000-8000-000000000001");

    let invalidCalls = 0;
    const invalid = new Agent({
      systemPrompt: "test",
      maxTurns: 2,
      streaming: false,
      workspace: unusedWorkspace,
      tools: [{
        name: "invalid_metadata_tool",
        description: "reject object-coercible metadata state",
        inputSchema: { type: "object" },
        async execute() { return { content: "bad", isError: false, shellOutput: { id: metadata.id, state: { toString: () => "complete" }, totalLines: 1 } } as never; },
      }],
      llm: { async complete(): Promise<LLMResponse> {
        invalidCalls += 1;
        return { message: invalidCalls === 1
          ? { role: "assistant", content: "", toolCalls: [toolCall("invalid-1", "invalid_metadata_tool", {})] }
          : { role: "assistant", content: "done", toolCalls: [] } };
      } },
    });
    const invalidResult = await invalid.run("test invalid metadata");
    expect(invalidResult.messages.find((message) => message.role === "tool")).toMatchObject({ isError: true });
  });

  it("rejects paths and malformed or expired IDs without exposing files", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const tool = new ReadShellOutputTool(store);
    const file = path.join(directory, "private.txt");
    await writeFile(file, "SECRET-138");
    await expect(tool.execute({ id: file, startLine: 1, lineCount: 1 }, context)).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ id: "../../private.txt" }, context)).resolves.toMatchObject({ isError: true });
    await store.close();
    await expect(tool.execute({ id: "00000000-0000-4000-8000-000000000000" }, context)).resolves.toMatchObject({ isError: true });
  });

  it("reports incomplete storage when a per-output cap is reached", async () => {
    const cwd = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: cwd });
    const bash = new BashTool({
      cwd,
      maxLines: 1,
      maxBytes: 10,
      outputStore: store,
      approve: async () => true,
      operations: {
        backend: "fake",
        async exec(_command, _cwd, options) {
          options.onData(Buffer.alloc(MAX_OUTPUT_FILE_BYTES + 1, 0x78));
          return { exitCode: 0 };
        },
      },
    });
    const result = await bash.execute({ command: "fake" }, context);
    const id = /Output ID: ([0-9a-f-]+)/.exec(result.content)?.[1];
    expect(result.content).toContain("saved: incomplete");
    expect(id).toBeDefined();
    const read = await new ReadShellOutputTool(store).execute({ id, startLine: 1, lineCount: 1 }, context);
    expect(read.isError).toBe(false);
    expect(read.content).toContain("Output incomplete");
    expect(read.content).toContain("[Read limited");
    expect(read.content.startsWith("x".repeat(1_000))).toBe(true);
    await store.close();
  });

  it("does not report complete output after spill write or close failures", async () => {
    const directory = await temporaryDirectory();
    const writeFailure = new OutputAccumulator({ maxBytes: 1, tempDirectory: directory, writeFileChunk: () => { throw new Error("disk full"); } });
    writeFailure.append(Buffer.from("first\nsecond\n"));
    writeFailure.finish();
    await writeFailure.close();
    expect(writeFailure.snapshot().fullOutputComplete).toBe(false);
    await writeFailure.discard();

    const closeFailure = new OutputAccumulator({ maxBytes: 1, tempDirectory: directory, closeFile: (descriptor) => { closeSync(descriptor); throw new Error("close failed"); } });
    closeFailure.append(Buffer.from("first\nsecond\n"));
    closeFailure.finish();
    await closeFailure.close();
    expect(closeFailure.snapshot().fullOutputComplete).toBe(false);
    await closeFailure.discard();
  });

  it("bounds raw chunks even when sanitization removes all content", async () => {
    const directory = await temporaryDirectory();
    const output = new OutputAccumulator({ tempDirectory: directory });
    output.append(Buffer.alloc(16 * 1024 * 1024, 0x01));
    expect(output.snapshot().truncation.totalBytes).toBe(0);
    expect(output.bufferedRawBytes).toBeLessThanOrEqual(MAX_OUTPUT_BUFFERED_RAW_BYTES);
    expect(output.bufferedRawBytes).toBe(0);
    expect(output.snapshot().fullOutputBytes).toBe(MAX_OUTPUT_FILE_BYTES);
    expect(output.snapshot().fullOutputComplete).toBe(false);
    await output.discard();
  });

  it("keeps the command exit result visible when spill creation fails", async () => {
    const parent = await temporaryDirectory();
    const blockedParent = path.join(parent, "a-file");
    await writeFile(blockedParent, "not a directory");
    const store = new ShellOutputStore({ tempDirectory: blockedParent });
    let executions = 0;
    const operations = createLocalShellOperations();
    const bash = new BashTool({
      cwd: parent,
      maxLines: 1,
      outputStore: store,
      approve: async () => true,
      operations: {
        backend: operations.backend,
        async exec(...args) {
          executions += 1;
          return operations.exec(...args);
        },
      },
    });
    const result = await bash.execute({ command: "printf 'first\nsecond\n'; exit 7" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Command exited with code 7");
    expect(result.content).toContain("saved: unavailable");
    expect(executions).toBe(1);
    await store.close();
  });

  it("refuses a symlink replacement and expires inactive references", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const stored = path.join(storeDirectory, "saved.log");
    const secret = path.join(directory, "secret.log");
    await writeFile(stored, "ordinary output\n");
    await writeFile(secret, "SECRET-138\n");
    const registrationSymlink = path.join(storeDirectory, "registration-symlink.log");
    await symlink(secret, registrationSymlink);
    await expect(store.register(registrationSymlink, 11, 1, true)).resolves.toMatchObject({ state: "unavailable" });
    const reference = await store.register(stored, Buffer.byteLength("ordinary output\n"), 1, true);
    await unlink(stored);
    await symlink(secret, stored);
    const replaced = await store.read(reference.id, 1, 1);
    expect(replaced.state).toBe("unavailable");
    await store.close();

    const expiring = new ShellOutputStore({ tempDirectory: directory, retentionMs: 0 });
    const expiryDir = await expiring.getTempDirectory();
    const expiryFile = path.join(expiryDir, "expiring.log");
    await writeFile(expiryFile, "old\n");
    const old = await expiring.register(expiryFile, 4, 1, true);
    await expect(expiring.read(old.id, 1, 1)).resolves.toMatchObject({ state: "unavailable" });
    await expiring.close();
  });

  it("refuses a regular-file replacement after the output ID was registered", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const stored = path.join(storeDirectory, "saved.log");
    const replacement = path.join(storeDirectory, "replacement.log");
    await writeFile(stored, "authorized output\n");
    const reference = await store.register(stored, 18, 1, true);
    await writeFile(replacement, "secret replacement\n");
    await unlink(stored);
    await import("node:fs/promises").then(({ rename }) => rename(replacement, stored));
    await expect(store.read(reference.id, 1, 1)).resolves.toMatchObject({ state: "unavailable", content: "" });
    await store.close();
  });

  it("rejects hard-linked output both before and after registration", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const original = path.join(storeDirectory, "output.log");
    const alias = path.join(directory, "outside-hardlink.log");
    await writeFile(original, "authorized output\n");
    await link(original, alias);
    const prelinked = await store.register(original, Buffer.byteLength("authorized output\n"), 1, true);
    expect(prelinked.state).toBe("unavailable");
    await unlink(alias);

    const replacement = await store.register(original, Buffer.byteLength("authorized output\n"), 1, true);
    expect(replacement.state).toBe("complete");
    await link(original, alias);
    await expect(store.read(replacement.id, 1, 1)).resolves.toMatchObject({ state: "unavailable", content: "" });

    const replacementFile = path.join(directory, "replacement.log");
    await writeFile(replacementFile, "unauthorized output\n");
    await unlink(original);
    await link(replacementFile, original);
    await expect(store.read(replacement.id, 1, 1)).resolves.toMatchObject({ state: "unavailable", content: "" });
    await store.close();
  });

  it("clears a directory created after the session was cleared during async setup", async () => {
    const parent = await temporaryDirectory();
    let release!: (directory: string) => void;
    const creation = new Promise<string>((resolve) => { release = resolve; });
    const store = new ShellOutputStore({ tempDirectory: parent, createTempDirectory: async () => creation });
    const pending = store.getTempDirectory();
    store.clear();
    const created = await mkdtemp(path.join(parent, "racing-output-"));
    release(created);
    await expect(pending).rejects.toThrow("closed");
    await expect(readdir(parent)).resolves.toEqual([]);
    await store.close();
  });

  it("caps the number of stored output files and reports unavailable older-session IDs", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const references: Array<{ id: string; state: string }> = [];
    for (let index = 0; index <= MAX_OUTPUT_SESSION_FILES; index += 1) {
      const file = path.join(storeDirectory, `output-${index}.log`);
      await writeFile(file, `line ${index}\n`);
      const reference = await store.register(file, Buffer.byteLength(`line ${index}\n`), 1, true);
      references.push(reference);
    }
    expect(references.at(-1)?.state).toBe("unavailable");
    await expect(store.read(references[0]!.id, 1, 1)).resolves.toMatchObject({ state: "complete", content: "line 0\n" });
    await expect(store.read(references.at(-1)!.id, 1, 1)).resolves.toMatchObject({ state: "unavailable", content: "" });
    await store.close();
  });


  it("removes partial spill files when a shell command is cancelled", async () => {
    const cwd = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: cwd });
    const directory = await store.getTempDirectory();
    const controller = new AbortController();
    let started!: () => void;
    const processStarted = new Promise<void>((resolve) => { started = resolve; });
    const bash = new BashTool({
      cwd,
      maxLines: 1,
      outputStore: store,
      approve: async () => true,
      operations: {
        backend: "fake",
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("first\nsecond\n"));
          started();
          return await new Promise((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
          });
        },
      },
    });
    const running = bash.execute({ command: "fake" }, { ...context, signal: controller.signal });
    await processStarted;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);
    await store.close();
  });

  it("sanitizes terminal controls and preserves UTF-8 split at the scan chunk boundary", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const file = path.join(storeDirectory, "utf8.log");
    const prefix = Buffer.concat([Buffer.from("A\u001b[31m"), Buffer.alloc(8188, 0x62)]);
    const suffix = Buffer.from("🌟\n", "utf8");
    const bytes = Buffer.concat([prefix, suffix]);
    await writeFile(file, bytes);
    const reference = await store.register(file, bytes.byteLength, 1, true);
    const result = await new ReadShellOutputTool(store).execute({ id: reference.id, startLine: 1, lineCount: 1 }, context);
    expect(result.content).toContain("A");
    expect(result.content).toContain("🌟");
    expect(result.content).not.toContain("\u001b");
    await store.close();
  });

  it("can seek to later lines in a large but capped saved output", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const file = path.join(storeDirectory, "later-line.log");
    const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 + 5, 0x78), Buffer.from("\nLATE-138\n")]);
    await writeFile(file, bytes);
    const reference = await store.register(file, bytes.byteLength, 2, true);
    const result = await new ReadShellOutputTool(store).execute({ id: reference.id, startLine: 2, lineCount: 1 }, context);
    expect(result.content).toContain("LATE-138");
    expect(result.content).toContain("Output complete");
    await store.close();
  });

  it("marks a line cut by the read byte cap as partial, never as a complete line", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const storeDirectory = await store.getTempDirectory();
    const file = path.join(storeDirectory, "scan-cap.log");
    const bytes = Buffer.alloc(MAX_OUTPUT_FILE_BYTES, 0x78);
    await writeFile(file, bytes);
    const reference = await store.register(file, bytes.length, 2, false);
    const result = await store.read(reference.id, 1, 1);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[partial line; read byte limit reached]");
    expect(result.linesRead).toBe(0);
    await store.close();
  });

  it("rejects line ranges that exceed the declared bounds", async () => {
    const directory = await temporaryDirectory();
    const store = new ShellOutputStore({ tempDirectory: directory });
    const tool = new ReadShellOutputTool(store);
    await expect(tool.execute({ id: "00000000-0000-4000-8000-000000000000", startLine: 1, lineCount: 201 }, context)).resolves.toMatchObject({ isError: true });
    await store.close();
  });

});
