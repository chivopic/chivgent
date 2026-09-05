import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialResolver } from "../src/auth/credentials.js";
import { EnvCredentialSource } from "../src/auth/env-credentials.js";
import { RuntimeCredentialSource } from "../src/auth/runtime-credentials.js";
import {
  AuthFileError,
  FileCredentialSource,
} from "../src/auth/file-credentials.js";
import type { ProviderDefinition } from "../src/providers/definitions.js";

const provider: ProviderDefinition = {
  id: "openai",
  envKeys: ["OPENAI_API_KEY", "OPENAI_TOKEN"],
  modelEnvKeys: [],
  baseUrlEnvKeys: [],
  requiresModel: false,
  requiresBaseURL: false,
  createClient: () => {
    throw new Error("not used");
  },
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "chivgent-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("EnvCredentialSource", () => {
  it("reads the declared variables in order", async () => {
    const source = new EnvCredentialSource({ OPENAI_TOKEN: "second" });

    expect(await source.read(provider)).toEqual({
      apiKey: "second",
      origin: "OPENAI_TOKEN",
    });
  });

  it("prefers the first declared variable", async () => {
    const source = new EnvCredentialSource({
      OPENAI_API_KEY: "first",
      OPENAI_TOKEN: "second",
    });

    expect(await source.read(provider)).toMatchObject({ apiKey: "first" });
  });

  it("ignores an empty variable", async () => {
    const source = new EnvCredentialSource({ OPENAI_API_KEY: "" });

    expect(await source.read(provider)).toBeUndefined();
  });
});

describe("FileCredentialSource", () => {
  it("returns nothing when the file does not exist", async () => {
    const root = await temporaryDirectory();
    const source = new FileCredentialSource(path.join(root, "auth.json"));

    expect(await source.read(provider)).toBeUndefined();
  });

  it("reads the typed entry form", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(
      file,
      JSON.stringify({ openai: { type: "api_key", key: "sk-typed" } }),
    );

    expect(await new FileCredentialSource(file).read(provider)).toMatchObject({
      apiKey: "sk-typed",
    });
  });

  it("reads the shorthand string form", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-short" }));

    expect(await new FileCredentialSource(file).read(provider)).toMatchObject({
      apiKey: "sk-short",
    });
  });

  it("returns nothing when the Provider is absent", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ deepseek: "sk-other" }));

    expect(await new FileCredentialSource(file).read(provider)).toBeUndefined();
  });

  it("reports malformed JSON instead of ignoring it", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, "{ not json");

    await expect(new FileCredentialSource(file).read(provider)).rejects.toThrow(
      AuthFileError,
    );
  });

  it("reports an entry that is neither a string nor an api_key object", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: { type: "oauth" } }));

    await expect(new FileCredentialSource(file).read(provider)).rejects.toThrow(
      /must be a string or/,
    );
  });

  it("warns when the file is readable by other users", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-loose" }));
    await chmod(file, 0o644);

    const warnings: string[] = [];
    const credential = await new FileCredentialSource(file, (message) =>
      warnings.push(message),
    ).read(provider);

    expect(credential).toMatchObject({ apiKey: "sk-loose" });
    expect(warnings.join("\n")).toContain("chmod 600");
  });

  it("stays quiet when the file is owner-only", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-tight" }));
    await chmod(file, 0o600);

    const warnings: string[] = [];
    await new FileCredentialSource(file, (message) =>
      warnings.push(message),
    ).read(provider);

    expect(warnings).toEqual([]);
  });
});

describe("CredentialResolver", () => {
  it("prefers a runtime key over the environment and the file", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-file" }));

    const resolver = new CredentialResolver([
      new RuntimeCredentialSource("sk-runtime"),
      new EnvCredentialSource({ OPENAI_API_KEY: "sk-env" }),
      new FileCredentialSource(file),
    ]);

    expect(await resolver.resolve(provider)).toEqual({
      apiKey: "sk-runtime",
      origin: "--api-key",
    });
  });

  it("prefers the environment over the file", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-file" }));

    const resolver = new CredentialResolver([
      new RuntimeCredentialSource(undefined),
      new EnvCredentialSource({ OPENAI_API_KEY: "sk-env" }),
      new FileCredentialSource(file),
    ]);

    expect(await resolver.resolve(provider)).toMatchObject({
      apiKey: "sk-env",
      origin: "OPENAI_API_KEY",
    });
  });

  it("falls back to the file when nothing else supplies a key", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "auth.json");
    await writeFile(file, JSON.stringify({ openai: "sk-file" }));

    const resolver = new CredentialResolver([
      new RuntimeCredentialSource(undefined),
      new EnvCredentialSource({}),
      new FileCredentialSource(file),
    ]);

    expect(await resolver.resolve(provider)).toMatchObject({
      apiKey: "sk-file",
    });
  });

  it("returns nothing when no source has a key", async () => {
    const resolver = new CredentialResolver([
      new RuntimeCredentialSource(undefined),
      new EnvCredentialSource({}),
    ]);

    expect(await resolver.resolve(provider)).toBeUndefined();
  });

  it("names the environment variables when explaining what is missing", () => {
    const resolver = new CredentialResolver([]);

    expect(resolver.describeExpectations(provider)).toContain(
      "OPENAI_API_KEY or OPENAI_TOKEN",
    );
  });
});
