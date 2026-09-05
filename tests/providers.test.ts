import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ProviderDefinition } from "../src/providers/definitions.js";
import { parseCliArgs, type CliOptions } from "../src/cli-options.js";
import { createConfiguredClient } from "../src/providers/client.js";
import { CredentialResolver } from "../src/auth/credentials.js";
import { RuntimeCredentialSource } from "../src/auth/runtime-credentials.js";

function fakeDefinition(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "fake",
    envKeys: ["FAKE_API_KEY"],
    modelEnvKeys: ["FAKE_MODEL"],
    defaultModel: "fake-1",
    baseUrlEnvKeys: ["FAKE_BASE_URL"],
    requiresModel: false,
    requiresBaseURL: false,
    createClient: () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  it("lists every registered id in the unknown-provider error", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.get("nope")).toThrow(/openai.*deepseek/s);
  });

  it("refuses a duplicate id", () => {
    const registry = new ProviderRegistry([fakeDefinition()]);

    expect(() => registry.register(fakeDefinition())).toThrow(
      "Duplicate Provider id: fake",
    );
  });

  it("accepts a Provider the CLI has never heard of", () => {
    const registry = new ProviderRegistry([fakeDefinition()]);

    const options = parseCliArgs(["--provider", "fake"], {}, registry);

    expect(options).toMatchObject({ provider: "fake", model: "fake-1" });
  });

  it("reads the model and base URL a definition declares", () => {
    const registry = new ProviderRegistry([fakeDefinition()]);

    const options = parseCliArgs(
      ["--provider", "fake"],
      { FAKE_MODEL: "fake-9", FAKE_BASE_URL: "https://fake.example" },
      registry,
    );

    expect(options).toMatchObject({
      model: "fake-9",
      baseURL: "https://fake.example",
    });
  });

  it("falls back to the declared default base URL", () => {
    const options = parseCliArgs(["--provider", "groq"], {
      GROQ_MODEL: "llama-3",
    });

    expect(options).toMatchObject({
      provider: "groq",
      model: "llama-3",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });

  it("rejects an unregistered provider on the command line", () => {
    expect(() => parseCliArgs(["--provider", "nope"], {})).toThrow(
      /Unsupported provider: nope/,
    );
  });
});

describe("createConfiguredClient", () => {
  const registry = new ProviderRegistry([
    fakeDefinition({ createClient: () => ({}) as never }),
    fakeDefinition({
      id: "needs-url",
      requiresBaseURL: true,
      baseUrlEnvKeys: ["NEEDS_URL_BASE_URL"],
    }),
    fakeDefinition({ id: "needs-model", defaultModel: undefined }),
  ]);

  function optionsFor(provider: string, extra = {}): CliOptions {
    return parseCliArgs(["--provider", provider], {}, registry) as CliOptions &
      typeof extra;
  }

  it("explains which variables would supply a missing key", async () => {
    const result = await createConfiguredClient(
      optionsFor("fake"),
      registry,
      new CredentialResolver([]),
    );

    expect(result).toContain("FAKE_API_KEY");
    expect(result).toContain("--api-key");
  });

  it("explains a missing base URL using the declared variable", async () => {
    const result = await createConfiguredClient(
      optionsFor("needs-url"),
      registry,
      new CredentialResolver([]),
    );

    expect(result).toBe("NEEDS_URL_BASE_URL is required for needs-url.");
  });

  it("explains a missing model using the declared variable", async () => {
    const result = await createConfiguredClient(
      optionsFor("needs-model"),
      registry,
      new CredentialResolver([]),
    );

    expect(result).toBe("--model or FAKE_MODEL is required for needs-model.");
  });

  it("builds a client once a key resolves", async () => {
    const result = await createConfiguredClient(
      optionsFor("fake"),
      registry,
      new CredentialResolver([new RuntimeCredentialSource("sk-test")]),
    );

    expect(typeof result).not.toBe("string");
  });

  it("surfaces an unreadable auth file instead of throwing", async () => {
    const failing = new CredentialResolver([
      {
        name: "broken",
        read: async () => {
          throw new Error("auth file exploded");
        },
      },
    ]);

    const result = await createConfiguredClient(
      optionsFor("fake"),
      registry,
      failing,
    );

    expect(result).toBe("auth file exploded");
  });
});
