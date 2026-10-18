import OpenAI from "openai";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIClient } from "../src/providers/openai.js";
import { OAuthRefreshingLLMClient } from "../src/providers/oauth-client.js";
import { defaultProviderRegistry } from "../src/providers/registry.js";
import { createConfiguredClient } from "../src/providers/client.js";
import { parseCliArgs } from "../src/cli-options.js";
import { CredentialResolver } from "../src/auth/credentials.js";
import { RuntimeCredentialSource } from "../src/auth/runtime-credentials.js";
import { writeOAuthCredential, removeOAuthCredential } from "../src/auth/oauth.js";
import type { LLMRequest } from "../src/llm.js";
import * as oauth from "../src/auth/oauth.js";
import { InteractiveProvider } from "../src/providers/interactive.js";
import { DeferredLLMClient } from "../src/providers/deferred-client.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function credentialFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chivgent-oauth-provider-"));
  directories.push(dir);
  return path.join(dir, "oauth.json");
}
const request: LLMRequest = { systemPrompt: "test", tools: [], messages: [{ role: "user", content: "hello" }] };
const answer = { message: { role: "assistant" as const, content: "done", toolCalls: [] } };

describe("OAuth provider integration", () => {
  it("keeps explicit OAuth across model switches, switches back to an entered key, and logs out independently", async () => {
    const file = await credentialFile();
    const saved = { type: "oauth" as const, provider: "xai" as const, clientId: "test", accessToken: "subscription-token", expiresAt: Date.now() + 3600000, scopes: ["api:access"] };
    const factory = vi.spyOn(defaultProviderRegistry.get("xai"), "createClient").mockImplementation(config => ({
      complete: async () => ({ ...answer, message: { ...answer.message, content: config.apiKey } }),
    }));
    vi.spyOn(oauth, "signInXAI").mockImplementation(async () => {
      await writeOAuthCredential(saved, file);
      return saved;
    });
    vi.spyOn(oauth, "revokeOAuthCredential").mockResolvedValue(true);
    const proxy = new DeferredLLMClient("not configured");
    const control = new InteractiveProvider(parseCliArgs(["--provider", "xai", "--model", "test"], {}), proxy,
      defaultProviderRegistry, {}, path.join(path.dirname(file), "auth.json"));
    expect(await control.oauth("xai")).toBeUndefined();
    expect(await control.needsApiKey()).toBe(false);
    await control.changeModel("next-model");
    expect((await proxy.complete(request)).message.content).toBe("subscription-token");
    expect(await control.submit("replacement-api-key")).toBeUndefined();
    await control.changeModel("third-model");
    expect((await proxy.complete(request)).message.content).toBe("replacement-api-key");
    expect(await control.signOut()).toContain("Signed out");
    expect((await proxy.complete(request)).message.content).toBe("replacement-api-key");
    expect(await oauth.readOAuthCredentials(file)).toEqual([]);
    expect(factory).toHaveBeenCalled();
  });

  it("ignores OPENAI_BASE_URL for subscription tokens and refuses redirects", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://untrusted.example/v1");
    const network = vi.fn<typeof fetch>(async () => new Response(
      'data: {"type":"response.completed","response":{"id":"resp-1","output_text":"done","output":[]}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", network);
    const client = new OpenAIClient({ apiKey: "subscription-secret", model: "test", oauth: true });
    await client.complete(request);
    expect(String(network.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
    expect(network.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("streams complete(), disables storage, and replays tool pairs without a stored response ID", async () => {
    const create = vi.fn(async function* () {
      yield { type: "response.output_text.delta", delta: "done" };
      yield { type: "response.completed", response: { id: "resp-new", output_text: "done", output: [] } };
    });
    const client = new OpenAIClient({ apiKey: "fake", model: "test", oauth: true, client: { responses: { create } } as unknown as OpenAI });
    const result = await client.complete({ ...request, continuation: { provider: "openai-responses", previousResponseId: "not-stored" }, messages: [
      ...request.messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "call-1", toolName: "read_file", content: "hello", isError: false },
    ] });
    expect(result.message.content).toBe("done");
    const sent = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(sent[0]).toMatchObject({ stream: true, store: false });
    expect(sent[0]).not.toHaveProperty("previous_response_id");
    expect(sent[0].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    ]));
  });

  it("rejects a stream that closes without response.completed", async () => {
    const create = vi.fn(async function* () { yield { type: "response.output_text.delta", delta: "partial" }; });
    const client = new OpenAIClient({ apiKey: "fake", model: "test", oauth: true, client: { responses: { create } } as unknown as OpenAI });
    await expect(client.complete(request)).rejects.toThrow("without a completed response");
  });

  it("uses current saved credentials on each request and stops after local logout", async () => {
    const file = await credentialFile();
    const factory = vi.spyOn(defaultProviderRegistry.get("xai"), "createClient").mockReturnValue({ complete: async () => answer });
    const credential = { type: "oauth" as const, provider: "xai" as const, clientId: "test", accessToken: "first", expiresAt: Date.now() + 3600000, scopes: ["api:access"] };
    await writeOAuthCredential(credential, file);
    const client = new OAuthRefreshingLLMClient("xai", "test", file);
    await client.complete(request);
    await writeOAuthCredential({ ...credential, accessToken: "second" }, file);
    await client.complete(request);
    expect(factory.mock.calls.map(call => call[0].apiKey)).toEqual(["first", "second"]);
    expect(factory.mock.calls[1]?.[0].baseURL).toBe("https://api.x.ai/v1");
    await removeOAuthCredential("xai", file);
    await expect(client.complete(request)).rejects.toThrow("No xai OAuth session");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("keeps API-key precedence even when the OAuth file is unavailable", async () => {
    const file = await credentialFile();
    const factory = vi.spyOn(defaultProviderRegistry.get("openai"), "createClient").mockReturnValue({ complete: async () => answer });
    const client = await createConfiguredClient(parseCliArgs([], {}), defaultProviderRegistry,
      new CredentialResolver([new RuntimeCredentialSource("explicit-key")]), file);
    expect(typeof client).not.toBe("string");
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "explicit-key" }));
  });

  it("refuses custom xAI OAuth endpoints before sending credentials", async () => {
    const file = await credentialFile();
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const result = await createConfiguredClient({ ...parseCliArgs(["--provider", "xai", "--model", "test"], {}), baseURL: "https://other.example/v1" },
      defaultProviderRegistry, new CredentialResolver([]), file);
    expect(result).toContain("cannot be used with a custom endpoint");
    expect(network).not.toHaveBeenCalled();
  });
});
