import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AuthFileError, writeApiKey } from "../src/auth/file-credentials.js";
import {
  DeferredLLMClient,
  NotSignedInError,
} from "../src/providers/deferred-client.js";
import { handleSlashCommand, runRepl, type SignIn } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import { assistant, FakeLLMClient, readOnlyWorkspaceWrites } from "./fakes.js";
import type { Workspace } from "../src/workspace.js";
import type { LLMRequest } from "../src/llm.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-login-"));
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

const workspace: Workspace = {
  root: "/workspace",
  ...readOnlyWorkspaceWrites,
  async readTextFile() {
    return { content: "", startLine: 1, endLine: 1, totalLines: 1, truncated: false };
  },
  async listFiles() {
    return { entries: [], truncated: false };
  },
  async searchText() {
    return { matches: [], truncated: false, scannedFiles: 0, skippedFiles: 0 };
  },
};

function createSession(llm = new FakeLLMClient([assistant("done")])): AgentSession {
  return new AgentSession({
    agent: { systemPrompt: "system", maxTurns: 4, llm, tools: [], workspace },
    cwd: "/workspace",
  });
}

const request: LLMRequest = { systemPrompt: "s", messages: [], tools: [] };

describe("writeApiKey", () => {
  it("creates an owner-only auth file", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "auth.json");

    await writeApiKey("openai", "sk-test", file);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ openai: "sk-test" });
    expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it("keeps the other Providers' keys", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "auth.json");
    await writeApiKey("openai", "sk-one", file);

    await writeApiKey("deepseek", "sk-two", file);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      openai: "sk-one",
      deepseek: "sk-two",
    });
  });

  it("replaces the key for a Provider that already has one", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "auth.json");
    await writeApiKey("openai", "sk-old", file);

    await writeApiKey("openai", "sk-new", file);

    expect(JSON.parse(await readFile(file, "utf8")).openai).toBe("sk-new");
  });

  it("refuses to overwrite a file it cannot parse", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "auth.json");
    await writeFile(file, "{ not json");

    // The unreadable file may hold the only copy of another key.
    await expect(writeApiKey("openai", "sk", file)).rejects.toBeInstanceOf(AuthFileError);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("rejects an empty key", async () => {
    const home = await temporaryDirectory();

    await expect(
      writeApiKey("openai", "   ", path.join(home, "auth.json")),
    ).rejects.toThrow(/must not be empty/);
  });

  it("trims whitespace around a pasted key", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "auth.json");

    await writeApiKey("openai", "  sk-padded\n", file);

    expect(JSON.parse(await readFile(file, "utf8")).openai).toBe("sk-padded");
  });
});

describe("DeferredLLMClient", () => {
  it("explains what is missing instead of failing obscurely", async () => {
    const client = new DeferredLLMClient("No API key for openai.");

    expect(client.ready).toBe(false);
    await expect(client.complete(request)).rejects.toBeInstanceOf(NotSignedInError);
    await expect(client.complete(request)).rejects.toThrow("No API key for openai.");
  });

  it("delegates once a Provider arrives", async () => {
    const client = new DeferredLLMClient("missing");
    client.set(new FakeLLMClient([assistant("hello")]));

    expect(client.ready).toBe(true);
    expect((await client.complete(request)).message.content).toBe("hello");
  });

  it("falls back to complete for a Provider that does not stream", async () => {
    const client = new DeferredLLMClient("missing");
    client.set(new FakeLLMClient([assistant("hello")]));

    const response = await client.stream(request, { onTextDelta: () => undefined });

    expect(response.message.content).toBe("hello");
  });

  it("can replace a key that turned out to be wrong", async () => {
    const client = new DeferredLLMClient("missing");
    client.set(new FakeLLMClient([assistant("first")]));
    client.set(new FakeLLMClient([assistant("second")]));

    expect((await client.complete(request)).message.content).toBe("second");
  });
});

describe("/login", () => {
  const signIn: SignIn = {
    provider: "openai",
    authFile: "/home/me/.chivgent/auth.json",
    ready: () => false,
    submit: async () => undefined,
  };

  it("hands the flow to the loop, which owns the terminal", () => {
    const outcome = handleSlashCommand("/login", {
      session: createSession(),
      write: () => undefined,
      signIn,
    });

    expect(outcome).toEqual({ kind: "login" });
  });

  it("says so when this session cannot store a key", () => {
    let output = "";
    const outcome = handleSlashCommand("/login", {
      session: createSession(),
      write: (text) => (output += text),
    });

    expect(outcome).toBe("handled");
    expect(output).toContain("cannot store a key");
  });

  it("is listed in the help", () => {
    let output = "";
    handleSlashCommand("/help", {
      session: createSession(),
      write: (text) => (output += text),
    });

    expect(output).toContain("/login");
  });

  it("cannot be taken over by an extension", () => {
    let output = "";
    const outcome = handleSlashCommand("/login", {
      session: createSession(),
      write: (text) => (output += text),
      signIn,
      extensionCommands: [
        { name: "login", source: "/ext/x.js", description: "impostor", run: () => undefined },
      ],
    });

    // The built-in wins: an extension must not intercept key entry.
    expect(outcome).toEqual({ kind: "login" });
  });
});

describe("the REPL without a key", () => {
  /** Drives the real loop over a pipe, the way a terminal would. */
  async function drive(
    lines: readonly string[],
    signIn: SignIn,
    llm = new FakeLLMClient([assistant("answered")]),
  ): Promise<{ session: AgentSession; output: string }> {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    let text = "";
    const session = createSession(llm);

    const finished = runRepl({
      session,
      input,
      output,
      stderr: { write: (chunk: string) => { text += chunk; } },
      signIn,
    });
    for (const line of lines) {
      input.write(`${line}\n`);
    }
    input.end();
    await finished;
    return { session, output: text };
  }

  it("refuses to run a prompt and points at /login", async () => {
    const { session, output } = await drive(["what is this project?"], {
      provider: "openai",
      authFile: "/tmp/auth.json",
      ready: () => false,
      submit: async () => undefined,
    });

    expect(output).toContain("Run /login to add one.");
    // The prompt was never sent, so the transcript stays empty.
    expect(session.messages).toEqual([]);
    expect(session.turns).toBe(0);
  });

  it("runs the prompt once a key is in place", async () => {
    const { session, output } = await drive(["what is this project?"], {
      provider: "openai",
      authFile: "/tmp/auth.json",
      ready: () => true,
      submit: async () => undefined,
    });

    expect(output).not.toContain("Run /login");
    expect(session.turns).toBe(1);
  });

  it("stores the key entered at the prompt and reports failures", async () => {
    const submitted: string[] = [];
    const { output } = await drive(["/login", "sk-typed-in"], {
      provider: "openai",
      authFile: "/tmp/auth.json",
      ready: () => false,
      submit: async (key) => {
        submitted.push(key);
        return undefined;
      },
    });

    expect(submitted).toEqual(["sk-typed-in"]);
    expect(output).toContain("Stored the key for openai");
  });

  it("reports why a key could not be stored", async () => {
    const { output } = await drive(["/login", "sk-bad"], {
      provider: "openai",
      authFile: "/tmp/auth.json",
      ready: () => false,
      submit: async () => "OPENAI_BASE_URL is required for openai-compatible.",
    });

    expect(output).toContain("OPENAI_BASE_URL is required");
    expect(output).not.toContain("Stored the key");
  });

  it("stores nothing when the answer is blank", async () => {
    const submitted: string[] = [];
    const { output } = await drive(["/login", "   "], {
      provider: "openai",
      authFile: "/tmp/auth.json",
      ready: () => false,
      submit: async (key) => {
        submitted.push(key);
        return undefined;
      },
    });

    expect(submitted).toEqual([]);
    expect(output).toContain("no key was stored");
  });
});
