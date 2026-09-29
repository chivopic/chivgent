import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";
import { DeferredLLMClient } from "../src/providers/deferred-client.js";
import type { ProviderDefinition } from "../src/providers/definitions.js";
import { InteractiveProvider } from "../src/providers/interactive.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { AgentSession } from "../src/session.js";
import { LocalWorkspace } from "../src/workspace.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function definition(id: string, defaults: { model?: string; needsURL?: boolean } = {}): ProviderDefinition {
  return {
    id,
    envKeys: [`${id.toUpperCase()}_API_KEY`],
    modelEnvKeys: [`${id.toUpperCase()}_MODEL`],
    ...(defaults.model === undefined ? {} : { defaultModel: defaults.model }),
    baseUrlEnvKeys: [`${id.toUpperCase()}_BASE_URL`],
    requiresModel: defaults.model === undefined,
    requiresBaseURL: defaults.needsURL ?? false,
    createClient: ({ model, baseURL }) => ({
      async complete() {
        return { message: { role: "assistant" as const, content: `${id}/${model}${baseURL ? ` @ ${baseURL}` : ""}`, toolCalls: [] } };
      },
    }),
  };
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chivgent-provider-test-"));
  temporary.push(directory);
  const authFile = path.join(directory, "auth.json");
  const registry = new ProviderRegistry([
    definition("first", { model: "first-default" }),
    definition("second"),
    definition("custom", { needsURL: true }),
  ]);
  const environment = { FIRST_API_KEY: "first-test-key" };
  const options = parseCliArgs(["--provider", "first"], environment, registry);
  const llm = new DeferredLLMClient("No key");
  const control = new InteractiveProvider(options, llm, registry, environment, authFile);
  const session = new AgentSession({ agent: {
    systemPrompt: "test", maxTurns: 2, llm, tools: [], streaming: false,
    workspace: new LocalWorkspace(process.cwd()),
  } });
  return { control, session, authFile };
}

describe("interactive Provider selection", () => {
  it("switches clients without losing conversation history, then restores a previous Provider", async () => {
    const { control, session, authFile } = await setup();
    expect((await control.select("first")).ok).toBe(true);
    expect(control.ready()).toBe(true);
    await session.prompt("one");

    expect((await control.select("second")).message).toContain("/model MODEL");
    expect((await control.changeModel("second-model")).message).toContain("API key needed for second");
    expect(control.provider).toBe("second");
    expect(control.ready()).toBe(false);
    expect(await control.submit("second-test-key")).toBeUndefined();
    expect(control.ready()).toBe(true);
    await session.prompt("two");

    expect((await control.select("first")).ok).toBe(true);
    await session.prompt("three");
    expect(session.messages.filter((message) => message.role === "assistant").map((message) => message.content))
      .toEqual(["first/first-default", "second/second-model", "first/first-default"]);
    expect(JSON.parse(await readFile(authFile, "utf8"))).toMatchObject({ second: "second-test-key" });
  });

  it("selects a Provider first and guides its separate model and endpoint setup", async () => {
    const { control, session } = await setup();
    await control.select("first");
    expect((await control.select("missing")).ok).toBe(false);
    expect((await control.select("custom")).message).toContain("/model MODEL and /endpoint URL");
    expect(control.unavailableMessage()).toContain("/model MODEL and /endpoint URL");
    expect(control.provider).toBe("custom");
    expect(control.ready()).toBe(false);
    expect((await control.changeModel("vendor-model")).message).toContain("/endpoint URL");
    expect(control.unavailableMessage()).toContain("/endpoint URL");
    expect((await control.changeEndpoint("file:///tmp/model")).ok).toBe(false);
    expect((await control.select("first")).ok).toBe(true);
    await session.prompt("still works");
    expect(session.messages.at(-1)).toMatchObject({ content: "first/first-default" });
  });

  it("accepts a custom endpoint and changes models within the session", async () => {
    const { control, session } = await setup();
    expect((await control.select("custom")).ok).toBe(true);
    expect((await control.changeModel("vendor-model")).ok).toBe(true);
    expect((await control.changeEndpoint("https://vendor.example/v1")).ok).toBe(true);
    expect(await control.submit("custom-test-key")).toBeUndefined();
    await session.prompt("one");
    expect((await control.changeModel("next-model")).ok).toBe(true);
    await session.prompt("two");
    expect(session.messages.filter((message) => message.role === "assistant").map((message) => message.content))
      .toEqual([
        "custom/vendor-model @ https://vendor.example/v1",
        "custom/next-model @ https://vendor.example/v1",
      ]);
  });

  it("stores a key before a Provider's model and endpoint are configured", async () => {
    const { control, session, authFile } = await setup();
    await control.select("custom");
    expect(await control.submit("early-key")).toBeUndefined();
    expect(await control.needsApiKey()).toBe(false);
    expect(control.ready()).toBe(false);
    expect(JSON.parse(await readFile(authFile, "utf8"))).toMatchObject({ custom: "early-key" });
    await control.changeModel("vendor-model");
    expect(control.ready()).toBe(false);
    await control.changeEndpoint("https://vendor.example/v1");
    expect(control.ready()).toBe(true);
    await session.prompt("hello");
    expect(session.messages.at(-1)).toMatchObject({ content: "custom/vendor-model @ https://vendor.example/v1" });
  });

  it("never reuses a startup --api-key for a different Provider", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chivgent-provider-test-"));
    temporary.push(directory);
    const registry = new ProviderRegistry([
      definition("first", { model: "first-default" }),
      definition("second", { model: "second-default" }),
    ]);
    const options = parseCliArgs(["--provider", "first", "--api-key", "first-only-key"], {}, registry);
    const llm = new DeferredLLMClient("No key");
    const control = new InteractiveProvider(options, llm, registry, {}, path.join(directory, "auth.json"));
    await control.select("first");
    expect(control.ready()).toBe(true);
    expect((await control.select("second")).message).toContain("API key needed for second");
    expect(control.ready()).toBe(false);
  });

  it("keeps a working Provider when constructing the replacement fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chivgent-provider-test-"));
    temporary.push(directory);
    const registry = new ProviderRegistry([
      definition("first", { model: "first-default" }),
      { ...definition("broken", { model: "broken-default" }),
        createClient: () => { throw new Error("invalid endpoint"); } },
    ]);
    const environment = { FIRST_API_KEY: "first-key", BROKEN_API_KEY: "broken-key" };
    const options = parseCliArgs(["--provider", "first"], environment, registry);
    const llm = new DeferredLLMClient("No key");
    const control = new InteractiveProvider(options, llm, registry, environment, path.join(directory, "auth.json"));
    await control.select("first");
    expect((await control.select("broken")).message).toContain("invalid endpoint");
    expect(control.provider).toBe("first");
    expect(control.ready()).toBe(true);
  });

  it("does not send OPENAI_API_KEY to a newly selected compatible endpoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chivgent-provider-test-"));
    temporary.push(directory);
    const registry = new ProviderRegistry();
    const environment = { OPENAI_API_KEY: "openai-only-key" };
    const options = parseCliArgs(["--provider", "openai"], environment, registry);
    const llm = new DeferredLLMClient("No key");
    const control = new InteractiveProvider(options, llm, registry, environment, path.join(directory, "auth.json"));
    await control.select("openai");
    expect(control.ready()).toBe(true);
    expect((await control.select("openai-compatible")).message).toContain("/model MODEL");
    expect((await control.changeModel("vendor-model")).message).toContain("/endpoint URL");
    expect((await control.changeEndpoint("https://vendor.example/v1")).message)
      .toContain("API key needed for openai-compatible");
    expect(await control.needsApiKey()).toBe(true);
    expect(control.ready()).toBe(false);
  });
});
