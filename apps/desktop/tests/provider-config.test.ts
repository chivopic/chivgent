import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopProviderConfig } from "../src/host/provider-config.js";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("desktop provider configuration", () => {
  it("persists profiles privately and never returns the key in status summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const config = new DesktopProviderConfig(root);
    const summary = await config.save({ provider: "openai-compatible", model: "local-model", baseURL: "http://127.0.0.1:43127/v1", apiKey: "fake-desktop-secret" });
    expect(summary).toEqual({ provider: "openai-compatible", model: "local-model", baseURL: "http://127.0.0.1:43127/v1", configured: true });
    expect(JSON.stringify(config.statusSync())).not.toContain("fake-desktop-secret");
    const file = join(root, "provider-profiles.json");
    expect(JSON.parse(await readFile(file, "utf8"))["openai-compatible"].apiKey).toBe("fake-desktop-secret");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("preserves other providers and refuses invalid endpoints without changing the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const config = new DesktopProviderConfig(root);
    await config.save({ provider: "openai", model: "gpt-5.6", apiKey: "openai-secret" });
    const before = await readFile(join(root, "provider-profiles.json"), "utf8");
    await expect(config.save({ provider: "openai-compatible", model: "custom", baseURL: "file:///tmp", apiKey: "other-secret" })).rejects.toThrow("endpoint");
    expect(await readFile(join(root, "provider-profiles.json"), "utf8")).toBe(before);
    expect(Object.keys(await config.read())).toEqual(["openai"]);
    await expect(config.save({ provider: "openai-compatible", model: "custom", baseURL: "https://example.test/v1?token=private", apiKey: "other-secret" })).rejects.toThrow("查询参数");
    await expect(config.save({ provider: "openai-compatible", model: "custom", baseURL: "https://user:pass@example.test/v1", apiKey: "other-secret" })).rejects.toThrow("凭证");
  });

  it("reports malformed profiles without throwing, preserves the damaged file, and allows recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const file = join(root, "provider-profiles.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, JSON.stringify({ openai: { provider: "openai", model: "x" } })));
    const config = new DesktopProviderConfig(root);
    const status = config.statusSync();
    expect(status.profiles).toEqual([]);
    expect(status.notice).toContain("配置文件损坏");
    expect(JSON.stringify(status)).not.toContain("fake");
    const summary = await config.save({ type: "save-provider-profile", requestId: "recover", provider: "openai", model: "gpt-recovery", apiKey: "recovery-secret" });
    expect(summary.recovered).toBe(true);
    expect(await readFile(file, "utf8")).toContain('"model":"x"');
    expect((await config.read()).openai?.apiKey).toBe("recovery-secret");
    expect(JSON.stringify(config.statusSync())).not.toContain("recovery-secret");
  });

  it("keeps host initialization available when profiles are malformed and sends only a recoverable notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const directory = join(root, "config");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory);
    await writeFile(join(directory, "provider-profiles.json"), '{"openai":{"provider":"openai","model":"","apiKey":"do-not-echo"}}');
    const messages: HostToMain[] = [];
    const host = new HostService({ send: (message) => messages.push(message), createAgent: () => { throw new Error("not used"); }, providerConfigDirectory: directory });
    expect(() => host.handle({ type: "initialize", requestId: "boot" })).not.toThrow();
    expect(messages[0]).toMatchObject({ type: "initialized", providerProfiles: [], providerConfigNotice: expect.stringContaining("配置文件损坏") });
    expect(JSON.stringify(messages)).not.toContain("do-not-echo");
  });

  it("updates a saved model and endpoint while retaining the key when the key field is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const config = new DesktopProviderConfig(root);
    await config.save({ type: "save-provider-profile", requestId: "initial", provider: "openai-compatible", model: "old-model", baseURL: "https://old.example/v1", apiKey: "keep-this-key" });
    await config.save({ type: "save-provider-profile", requestId: "change", provider: "openai-compatible", model: "new-model", baseURL: "https://new.example/v1" });
    expect(await config.read()).toMatchObject({ "openai-compatible": { model: "new-model", baseURL: "https://new.example/v1", apiKey: "keep-this-key" } });
  });

  it("preserves a malformed recovery file before writing a replacement profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-provider-")); roots.push(root);
    const recovery = join(root, "provider-profiles-recovered.json");
    const damaged = '{"openai":{"provider":"openai","model":"","apiKey":"preserve-this-file"}}';
    await import("node:fs/promises").then(({ writeFile }) => writeFile(recovery, damaged));
    const config = new DesktopProviderConfig(root);
    const saved = await config.save({ type: "save-provider-profile", requestId: "repair", provider: "openai", model: "recovered-model", apiKey: "new-key" });
    expect(saved.recovered).toBe(true);
    expect(await readFile(recovery, "utf8")).toContain("recovered-model");
    const backup = (await readdir(root)).find((name) => name.startsWith("provider-profiles-recovered.json.corrupt-"));
    expect(backup).toBeDefined();
    expect(await readFile(join(root, backup!), "utf8")).toBe(damaged);
  });
});
