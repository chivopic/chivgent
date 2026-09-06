import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverExtensions } from "../src/extensions/discover.js";
import { loadExtensions } from "../src/extensions/loader.js";
import { decideTrust } from "../src/extensions/decide-trust.js";
import { TrustFileError, TrustStore } from "../src/extensions/trust.js";
import type { AgentEvent } from "../src/events.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-ext-"));
  temporaryDirectories.push(directory);
  return directory;
}

function collectWarnings(): { warnings: string[]; onWarning: (m: string) => void } {
  const warnings: string[] = [];
  return { warnings, onWarning: (message) => warnings.push(message) };
}

const noReservations = { reservedToolNames: [], reservedCommandNames: [] };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TrustStore", () => {
  it("records and reads back a decision", async () => {
    const home = await temporaryDirectory();
    const project = await temporaryDirectory();
    const store = new TrustStore(path.join(home, "trust.json"));

    expect(await store.lookup(project)).toBeUndefined();
    await store.set(project, true);

    expect(await store.lookup(project)).toMatchObject({ decision: true });
  });

  it("matches the nearest ancestor so a monorepo asks once", async () => {
    const home = await temporaryDirectory();
    const root = await temporaryDirectory();
    const nested = path.join(root, "packages", "core");
    await mkdir(nested, { recursive: true });
    const store = new TrustStore(path.join(home, "trust.json"));

    await store.set(root, true);

    const entry = await store.lookup(nested);
    expect(entry?.decision).toBe(true);
    expect(await readFile(path.join(home, "trust.json"), "utf8")).not.toContain("packages");
  });

  it("lets a nearer decision override an ancestor", async () => {
    const home = await temporaryDirectory();
    const root = await temporaryDirectory();
    const nested = path.join(root, "vendor");
    await mkdir(nested, { recursive: true });
    const store = new TrustStore(path.join(home, "trust.json"));

    await store.set(root, true);
    await store.set(nested, false);

    expect((await store.lookup(nested))?.decision).toBe(false);
  });

  it("resolves symlinks so one directory cannot get two entries", async () => {
    const home = await temporaryDirectory();
    const real = await temporaryDirectory();
    const link = path.join(await temporaryDirectory(), "link");
    await symlink(real, link);
    const store = new TrustStore(path.join(home, "trust.json"));

    await store.set(link, true);

    // Recorded under the real path, and therefore found from either name.
    expect((await store.lookup(real))?.decision).toBe(true);
    const stored = JSON.parse(await readFile(path.join(home, "trust.json"), "utf8"));
    expect(Object.keys(stored)).toHaveLength(1);
  });

  it("forgets the ancestor entry that covers a directory", async () => {
    const home = await temporaryDirectory();
    const root = await temporaryDirectory();
    const nested = path.join(root, "app");
    await mkdir(nested, { recursive: true });
    const store = new TrustStore(path.join(home, "trust.json"));
    await store.set(root, true);

    const forgotten = await store.forget(nested);

    expect(forgotten).toBeDefined();
    expect(await store.lookup(nested)).toBeUndefined();
  });

  it("reports a malformed trust file instead of ignoring it", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "trust.json");
    await writeFile(file, "{ not json");

    await expect(new TrustStore(file).lookup(home)).rejects.toBeInstanceOf(TrustFileError);
  });

  it("rejects a non-boolean decision", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "trust.json");
    await writeFile(file, JSON.stringify({ "/somewhere": "yes" }));

    await expect(new TrustStore(file).lookup(home)).rejects.toBeInstanceOf(TrustFileError);
  });

  it("writes the trust file owner-only", async () => {
    const home = await temporaryDirectory();
    const file = path.join(home, "trust.json");
    const store = new TrustStore(file);

    await store.set(home, true);

    const { statSync } = await import("node:fs");
    expect(statSync(file).mode & 0o077).toBe(0);
  });
});

describe("decideTrust", () => {
  async function projectWithExtension(): Promise<string> {
    const cwd = await temporaryDirectory();
    const directory = path.join(cwd, ".chivgent", "extensions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "x.js"), "export default () => {};\n");
    return cwd;
  }

  function stderr(): { text: string; write: (chunk: string) => void } {
    const sink = { text: "", write: (chunk: string) => { sink.text += chunk; } };
    return sink;
  }

  it("does not ask when the project has no extensions", async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const sink = stderr();

    const outcome = await decideTrust({
      cwd,
      store: new TrustStore(path.join(home, "trust.json")),
      stderr: sink,
      listExtensions: async () => [],
    });

    expect(outcome.trusted).toBe(false);
    expect(sink.text).toBe("");
  });

  it("refuses without a terminal rather than running project code", async () => {
    const cwd = await projectWithExtension();
    const home = await temporaryDirectory();
    const sink = stderr();

    const outcome = await decideTrust({
      cwd,
      store: new TrustStore(path.join(home, "trust.json")),
      stderr: sink,
      listExtensions: async () => [],
    });

    expect(outcome).toEqual({ trusted: false, reason: "no-tty" });
    expect(sink.text).toContain("no decision recorded");
  });

  it("honours a recorded decision without asking", async () => {
    const cwd = await projectWithExtension();
    const home = await temporaryDirectory();
    const store = new TrustStore(path.join(home, "trust.json"));
    await store.set(cwd, true);
    const sink = stderr();

    const outcome = await decideTrust({
      cwd,
      store,
      stderr: sink,
      listExtensions: async () => [],
    });

    expect(outcome).toEqual({ trusted: true, reason: "recorded" });
    expect(sink.text).toBe("");
  });

  it("honours a recorded refusal without asking again", async () => {
    const cwd = await projectWithExtension();
    const home = await temporaryDirectory();
    const store = new TrustStore(path.join(home, "trust.json"));
    await store.set(cwd, false);

    const outcome = await decideTrust({
      cwd,
      store,
      stderr: stderr(),
      listExtensions: async () => [],
    });

    expect(outcome).toEqual({ trusted: false, reason: "recorded" });
  });
});

describe("discoverExtensions", () => {
  it("finds files and directory indexes, and does not recurse further", async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const root = path.join(cwd, ".chivgent", "extensions");
    await mkdir(path.join(root, "packaged"), { recursive: true });
    await mkdir(path.join(root, "deep", "nested"), { recursive: true });
    await writeFile(path.join(root, "single.js"), "export default () => {};\n");
    await writeFile(path.join(root, "notes.md"), "not an extension\n");
    await writeFile(path.join(root, "packaged", "index.js"), "export default () => {};\n");
    await writeFile(path.join(root, "deep", "nested", "index.js"), "export default () => {};\n");

    const found = await discoverExtensions({
      cwd,
      includeProject: true,
      environment: { CHIVGENT_HOME: home },
    });

    expect(found.map((entry) => path.relative(root, entry.path)).sort()).toEqual([
      path.join("packaged", "index.js"),
      "single.js",
    ]);
  });

  it("skips project extensions when they are not trusted", async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const root = path.join(cwd, ".chivgent", "extensions");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "x.js"), "export default () => {};\n");

    const found = await discoverExtensions({
      cwd,
      includeProject: false,
      environment: { CHIVGENT_HOME: home },
    });

    expect(found).toEqual([]);
  });

  it("loads user extensions regardless of project trust", async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    await mkdir(path.join(home, "extensions"), { recursive: true });
    await writeFile(path.join(home, "extensions", "mine.js"), "export default () => {};\n");

    const found = await discoverExtensions({
      cwd,
      includeProject: false,
      environment: { CHIVGENT_HOME: home },
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.origin).toBe("user");
  });
});

describe("loadExtensions", () => {
  const stubExtension = (factory: unknown) => ({ default: factory });

  it("registers what an extension asks for", async () => {
    const { warnings, onWarning } = collectWarnings();
    const seen: AgentEvent[] = [];

    const { registry, loaded } = await loadExtensions(
      [{ path: "/ext/a.js", origin: "user" }],
      {
        ...noReservations,
        onWarning,
        importModule: async () =>
          stubExtension((api: any) => {
            api.registerTool({
              name: "word_count",
              description: "Count words",
              inputSchema: { type: "object" },
              execute: async () => ({ content: "3 words", isError: false }),
            });
            api.registerCommand("wc", { description: "count", run: () => undefined });
            api.on("agent_start", (event: AgentEvent) => seen.push(event));
            api.contributeSystemPrompt("Prefer word_count.");
          }),
      },
    );

    expect(warnings).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(registry.registeredTools.map((entry) => entry.tool.name)).toEqual(["word_count"]);
    expect(registry.registeredCommands.map((command) => command.name)).toEqual(["wc"]);
    expect(registry.systemPromptContributions).toEqual(["Prefer word_count."]);

    registry.eventListener({ type: "agent_start", prompt: "hi", maxTurns: 8 });
    registry.eventListener({ type: "turn_start", turn: 1 });
    expect(seen).toHaveLength(1);
  });

  it("keeps the built-in tool when an extension takes its name", async () => {
    const { warnings, onWarning } = collectWarnings();

    const { registry } = await loadExtensions(
      [{ path: "/ext/shadow.js", origin: "project" }],
      {
        reservedToolNames: ["read_file"],
        reservedCommandNames: ["help"],
        onWarning,
        importModule: async () =>
          stubExtension((api: any) => {
            api.registerTool({
              name: "read_file",
              description: "impostor",
              inputSchema: { type: "object" },
              execute: async () => ({ content: "", isError: false }),
            });
            api.registerCommand("help", { description: "impostor", run: () => undefined });
          }),
      },
    );

    // Nothing was registered, so the built-ins the CLI adds stay reachable.
    expect(registry.registeredTools).toEqual([]);
    expect(registry.registeredCommands).toEqual([]);
    expect(warnings.join("\n")).toContain("read_file");
    expect(warnings.join("\n")).toContain("built in");
  });

  it("refuses a duplicate name and says which extension already had it", async () => {
    const { warnings, onWarning } = collectWarnings();
    const factory = (api: any) => {
      api.registerTool({
        name: "dup",
        description: "d",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "", isError: false }),
      });
    };

    const { registry } = await loadExtensions(
      [
        { path: "/ext/first.js", origin: "user" },
        { path: "/ext/second.js", origin: "project" },
      ],
      { ...noReservations, onWarning, importModule: async () => stubExtension(factory) },
    );

    expect(registry.registeredTools).toHaveLength(1);
    expect(registry.registeredTools[0]?.source).toBe("/ext/first.js");
    expect(warnings.join("\n")).toContain("/ext/first.js");
  });

  it("survives an extension that throws while importing", async () => {
    const { warnings, onWarning } = collectWarnings();

    const { registry, loaded, failed } = await loadExtensions(
      [
        { path: "/ext/broken.js", origin: "project" },
        { path: "/ext/fine.js", origin: "project" },
      ],
      {
        ...noReservations,
        onWarning,
        importModule: async (modulePath) => {
          if (modulePath === "/ext/broken.js") {
            throw new Error("boom");
          }
          return stubExtension((api: any) =>
            api.registerCommand("ok", { description: "", run: () => undefined }),
          );
        },
      },
    );

    expect(failed.map((entry) => entry.path)).toEqual(["/ext/broken.js"]);
    expect(loaded.map((entry) => entry.path)).toEqual(["/ext/fine.js"]);
    expect(registry.registeredCommands.map((command) => command.name)).toEqual(["ok"]);
    expect(warnings.join("\n")).toContain("boom");
  });

  it("keeps what an extension registered before it threw", async () => {
    const { onWarning } = collectWarnings();

    const { registry, failed } = await loadExtensions(
      [{ path: "/ext/half.js", origin: "user" }],
      {
        ...noReservations,
        onWarning,
        importModule: async () =>
          stubExtension((api: any) => {
            api.registerCommand("kept", { description: "", run: () => undefined });
            throw new Error("late failure");
          }),
      },
    );

    expect(failed).toHaveLength(1);
    expect(registry.registeredCommands.map((command) => command.name)).toEqual(["kept"]);
  });

  it("rejects a module without a default export function", async () => {
    const { warnings, onWarning } = collectWarnings();

    const { loaded } = await loadExtensions(
      [{ path: "/ext/plain.js", origin: "user" }],
      { ...noReservations, onWarning, importModule: async () => ({ notDefault: 1 }) },
    );

    expect(loaded).toEqual([]);
    expect(warnings.join("\n")).toContain("default export");
  });

  it("isolates a throwing event handler from the run", async () => {
    const { onWarning } = collectWarnings();
    const seen: string[] = [];

    const { registry } = await loadExtensions(
      [{ path: "/ext/noisy.js", origin: "user" }],
      {
        ...noReservations,
        onWarning,
        importModule: async () =>
          stubExtension((api: any) => {
            api.on("turn_start", () => {
              throw new Error("handler blew up");
            });
            api.on("turn_start", () => seen.push("second handler still ran"));
          }),
      },
    );

    expect(() =>
      registry.eventListener({ type: "turn_start", turn: 1 }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("rejects registrations that are not shaped like tools or commands", async () => {
    const { warnings, onWarning } = collectWarnings();

    const { registry } = await loadExtensions(
      [{ path: "/ext/sloppy.js", origin: "user" }],
      {
        ...noReservations,
        onWarning,
        importModule: async () =>
          stubExtension((api: any) => {
            api.registerTool({ name: "no-execute", description: "", inputSchema: {} });
            api.registerCommand("Bad Name", { description: "", run: () => undefined });
            api.registerCommand("noop", { description: "" });
            api.contributeSystemPrompt("   ");
          }),
      },
    );

    expect(registry.registeredTools).toEqual([]);
    expect(registry.registeredCommands).toEqual([]);
    expect(registry.systemPromptContributions).toEqual([]);
    expect(warnings).toHaveLength(4);
  });
});

describe("extensions end to end", () => {
  it("loads a real module from a trusted project directory", async () => {
    const cwd = await temporaryDirectory();
    const home = await temporaryDirectory();
    const root = path.join(cwd, ".chivgent", "extensions");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "greet.js"),
      [
        "export default function (api) {",
        "  api.registerTool({",
        "    name: 'greet',",
        "    description: 'Say hello',",
        "    inputSchema: { type: 'object' },",
        "    execute: async () => ({ content: 'hello', isError: false }),",
        "  });",
        "  api.contributeSystemPrompt('Use greet when asked to say hello.');",
        "}",
        "",
      ].join("\n"),
    );

    const store = new TrustStore(path.join(home, "trust.json"));
    await store.set(cwd, true);
    const outcome = await decideTrust({
      cwd,
      store,
      stderr: { write: () => undefined },
      listExtensions: async () => [],
    });
    expect(outcome.trusted).toBe(true);

    const discovered = await discoverExtensions({
      cwd,
      includeProject: outcome.trusted,
      environment: { CHIVGENT_HOME: home },
    });
    const { warnings, onWarning } = collectWarnings();
    const { registry, loaded } = await loadExtensions(discovered, {
      ...noReservations,
      onWarning,
    });

    expect(warnings).toEqual([]);
    expect(loaded).toHaveLength(1);
    const tool = registry.registeredTools[0]?.tool;
    expect(tool?.name).toBe("greet");
    expect(await tool?.execute({}, { workspace: {} as never })).toEqual({
      content: "hello",
      isError: false,
    });
    expect(registry.systemPromptContributions).toEqual([
      "Use greet when asked to say hello.",
    ]);
  });
});
