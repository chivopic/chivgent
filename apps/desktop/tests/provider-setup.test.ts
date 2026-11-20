import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopSession } from "@chivgent/runtime/desktop-runtime.ts";
import { HostService } from "../src/host/service.js";
import type { HostToMain } from "../src/protocol/messages.js";

// This fake is just a reversible stand-in for the OS keystore. It lets the
// test exercise the real store's writes and reads without touching Keychain.
const fakeCodec = {
  encrypt: async (key: string) => `sealed:${Buffer.from(key).toString("base64")}`,
  decrypt: async (ciphertext: string) => {
    if (!ciphertext.startsWith("sealed:")) throw new Error("cannot decrypt fixture");
    return Buffer.from(ciphertext.slice(7), "base64").toString();
  },
};

afterEach(() => vi.unstubAllGlobals());

it("validates the imported key, restores it after restart, and uses it for the first DeepSeek turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chivgent-provider-setup-"));
  const services: HostService[] = [];
  try {
    const file = join(cwd, "provider-profiles.json");
    const environment: NodeJS.ProcessEnv = { CHIVGENT_HOME: cwd };
    const acceptedKey = "sk-fixture-desktop-connection";
    const rejectedKey = "sk-fixture-rejected";
    const requests: Array<{ url: string; key: string | null; data: unknown }> = [];
    const fakeApi: typeof fetch = vi.fn(async (url, init) => {
      const key = new Headers(init?.headers).get("Authorization");
      const data = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url: String(url), key, data });
      if (key !== `Bearer ${acceptedKey}`) return new Response(`Invalid key: ${key}`, { status: 401 });
      if (String(url) === "https://api.deepseek.com/models") {
        return Response.json({ object: "list", data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }] });
      }
      if (String(url) === "https://api.deepseek.com/chat/completions") {
        const chunk = { id: "chat-fixture", object: "chat.completion.chunk", model: "deepseek-flash", created: 1,
          choices: [{ index: 0, delta: { role: "assistant", content: "DeepSeek 已回复" }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error("Unexpected fixture URL");
    });
    vi.stubGlobal("fetch", fakeApi);

    function launchHost() {
      const events: HostToMain[] = [];
      const service = new HostService({
        send: (event) => events.push(event),
        providerConfigDirectory: cwd,
        deepSeekCredentialCodec: fakeCodec,
        providerEnvironment: environment,
        createAgent: () => { throw new Error("Expected a real desktop session"); },
        createSession: async (project, provider, model, messages, compaction, permissionMode, approval, profile) => createDesktopSession({
          cwd: project, provider, model, environment, messages, compaction, permissionMode, approval,
          importedDeepSeekKey: profile?.encrypted ? profile.apiKey : undefined,
        }),
      });
      services.push(service);
      return { service, events };
    }

    const first = launchHost();
    first.service.handle({ type: "initialize", requestId: "first-launch" });
    await vi.waitFor(() => expect(first.events).toContainEqual(expect.objectContaining({ type: "initialized", readyProviders: [] })));
    expect(requests).toHaveLength(0);
    first.service.handle({ type: "connect-deepseek", requestId: "invalid", apiKey: rejectedKey });
    await vi.waitFor(() => expect(first.events).toContainEqual(expect.objectContaining({ type: "error", requestId: "invalid", code: "invalid_key" })));
    await expect(stat(file)).rejects.toHaveProperty("code", "ENOENT");
    first.service.handle({ type: "connect-deepseek", requestId: "connect", apiKey: ` ${acceptedKey} ` });
    await vi.waitFor(() => expect(first.events).toContainEqual(expect.objectContaining({ type: "provider-profile-saved", requestId: "connect" })));
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain(acceptedKey);
    expect(JSON.parse(stored).deepseek).toEqual({ provider: "deepseek", model: "deepseek-flash", encryptedApiKey: expect.stringMatching(/^sealed:/) });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(first.events)).not.toMatch(/sk-fixture/);
    await first.service.shutdown();

    environment.DEEPSEEK_API_KEY = "sk-old-environment-key";
    const restarted = launchHost();
    restarted.service.handle({ type: "initialize", requestId: "restart" });
    await vi.waitFor(() => expect(restarted.events).toContainEqual(expect.objectContaining({ type: "initialized", defaultProvider: "deepseek", readyProviders: ["deepseek"] })));
    expect(requests).toHaveLength(2);
    restarted.service.handle({ type: "select-project", requestId: "project", path: cwd });
    await vi.waitFor(() => expect(restarted.events).toContainEqual(expect.objectContaining({ type: "project-selected" })));
    restarted.service.handle({ type: "start", requestId: "send", prompt: "你好", provider: "deepseek" });
    await vi.waitFor(() => expect(restarted.events).toContainEqual(expect.objectContaining({ type: "event", event: expect.objectContaining({ type: "agent_end", status: "completed" }) })));
    expect(JSON.stringify(restarted.events)).toContain("DeepSeek 已回复");
    expect(JSON.stringify(restarted.events)).not.toContain(acceptedKey);
    expect(requests).toEqual([
      { url: "https://api.deepseek.com/models", key: `Bearer ${rejectedKey}`, data: undefined },
      { url: "https://api.deepseek.com/models", key: `Bearer ${acceptedKey}`, data: undefined },
      { url: "https://api.deepseek.com/chat/completions", key: `Bearer ${acceptedKey}`, data: expect.objectContaining({ model: "deepseek-flash", stream: true }) },
    ]);
  } finally {
    await Promise.all(services.map((service) => service.shutdown()));
    await rm(cwd, { recursive: true, force: true });
  }
});
