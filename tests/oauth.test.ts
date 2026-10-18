import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { readOAuthCredentials, refreshOAuthCredential, refreshSavedOAuthCredential, removeOAuthCredential, signInOpenAI, signInXAI, writeOAuthCredential, type OAuthCredential } from "../src/auth/oauth.js";
import { OpenAIClient } from "../src/providers/openai.js";

const dirs: string[] = [];
async function temp(): Promise<string> { const p = await mkdtemp(path.join(tmpdir(), "chivgent-oauth-")); dirs.push(p); return p; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

const credential: OAuthCredential = { type: "oauth", provider: "xai", clientId: "client", accessToken: "access-old", refreshToken: "refresh-old", expiresAt: 0, scopes: ["api:access"] };

describe("OAuth credential lifecycle", () => {
  it("retains full transcript and each stateless response exactly once across three tool rounds", async () => {
    const output1 = [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    ];
    const output2 = [
      { type: "reasoning", id: "rs_2", encrypted_content: "opaque-reasoning-2" },
      { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{}" },
    ];
    const requests: Record<string, unknown>[] = [];
    const create = vi.fn(async function* (parameters: Record<string, unknown>) {
      requests.push(parameters);
      const output = requests.length === 1 ? output1 : requests.length === 2 ? output2 : [{ type: "message", content: [] }];
      yield { type: "response.completed", response: { id: `resp_${requests.length}`, output_text: "", output } };
    });
    const client = new OpenAIClient({ apiKey: "test-token", model: "test", oauth: true,
      client: { responses: { create } } as unknown as OpenAI });
    const first = await client.complete({ systemPrompt: "test", tools: [], messages: [{ role: "user", content: "read" }] });
    const second = await client.complete({ systemPrompt: "test", tools: [], continuation: first.continuation, messages: [
      { role: "user", content: "read" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", toolName: "read_file", content: "file contents", isError: false },
    ] });
    await client.complete({ systemPrompt: "test", tools: [], continuation: second.continuation, messages: [
      { role: "user", content: "read" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", toolName: "read_file", content: "file contents", isError: false },
      { role: "assistant", content: "", toolCalls: [{ id: "call_2", name: "read_file", arguments: { path: "b" } }] },
      { role: "tool", toolCallId: "call_2", toolName: "read_file", content: "second file", isError: false },
    ] });
    expect(requests[0]?.include).toContain("reasoning.encrypted_content");
    expect(requests[1]?.input).toEqual([
      { role: "user", content: "read" },
      ...output1,
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
    ]);
    expect(requests[2]?.input).toEqual([
      { role: "user", content: "read" },
      ...output1,
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
      ...output2,
      { type: "function_call_output", call_id: "call_2", output: "second file" },
    ]);
    const thirdInput = requests[2]?.input as Array<{ type?: string; call_id?: string }>;
    for (const callId of ["call_1", "call_2"]) {
      expect(thirdInput.filter((item) => item.type === "function_call" && item.call_id === callId)).toHaveLength(1);
      expect(thirdInput.filter((item) => item.type === "function_call_output" && item.call_id === callId)).toHaveLength(1);
    }
    expect(requests[1]).not.toHaveProperty("previous_response_id");
    expect(requests[2]).not.toHaveProperty("previous_response_id");
  });

  it("stores credentials separately in an owner-only file and atomically replaces a provider", async () => {
    const file = path.join(await temp(), "oauth.json");
    await writeOAuthCredential(credential, file);
    await writeOAuthCredential({ ...credential, accessToken: "access-new", refreshToken: "refresh-new" }, file);
    expect((await readOAuthCredentials(file)).map((x) => x.accessToken)).toEqual(["access-new"]);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))[0].type).toBe("oauth");
  });

  it("preserves refresh rotation and serializes concurrent refreshes", async () => {
    const file = path.join(await temp(), "oauth.json");
    await writeOAuthCredential(credential, file);
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token" });
      calls++; await Promise.resolve(); return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 });
    };
    const [a, b] = await Promise.all([refreshSavedOAuthCredential("xai", file, fetcher), refreshSavedOAuthCredential("xai", file, fetcher)]);
    expect(calls).toBe(1);
    expect(a?.refreshToken).toBe("refresh-new");
    expect(b?.accessToken).toBe("access-new");
  });

  it("does not restore a session when logout races with refresh", async () => {
    const file = path.join(await temp(), "oauth.json");
    await writeOAuthCredential(credential, file);
    let announce!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token" });
      announce(); await gate;
      return Response.json({ access_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600 });
    };
    const refreshing = refreshSavedOAuthCredential("xai", file, fetcher);
    await started;
    const signingOut = removeOAuthCredential("xai", file);
    finish();
    await Promise.all([refreshing, signingOut]);
    expect(await readOAuthCredentials(file)).toEqual([]);
  });

  it("does not include tokens from an upstream error body in errors", async () => {
    const fetcher: typeof fetch = async (input) => String(input).endsWith("openid-configuration")
      ? Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token" })
      : new Response(JSON.stringify({ error: "invalid_grant", access_token: "secret-token" }), { status: 400 });
    await expect(refreshOAuthCredential(credential, fetcher)).rejects.toThrow("invalid_grant");
    await expect(refreshOAuthCredential(credential, fetcher)).rejects.not.toThrow("secret-token");
    await expect(refreshOAuthCredential(credential, async () => new Response('{"access_token":"secret-token'))).rejects.not.toThrow("secret-token");
    await expect(refreshOAuthCredential(credential, async (input) => String(input).endsWith("openid-configuration")
      ? Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token" })
      : new Response(JSON.stringify({ error: "secret-token" }), { status: 400 }))).rejects.toThrow("oauth_error");
  });

  it("removes persisted credentials on sign-out", async () => {
    const file = path.join(await temp(), "oauth.json");
    await writeOAuthCredential(credential, file);
    await removeOAuthCredential("xai", file);
    expect(await readOAuthCredentials(file)).toEqual([]);
  });

  it("rejects malformed credential records rather than silently discarding them", async () => {
    const file = path.join(await temp(), "oauth.json");
    await writeFile(file, JSON.stringify([{ type: "oauth", accessToken: "leak" }]));
    await expect(readOAuthCredentials(file)).rejects.toThrow("invalid record");
  });
});

describe("xAI RFC 8628 device login", () => {
  it("waits for approval and saves the returned typed credential", async () => {
    const file = path.join(await temp(), "oauth.json");
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"], scopes_supported: ["api:access", "offline_access"] });
      if (url.endsWith("/device/code")) return Response.json({ device_code: "device", user_code: "ABCD-EFGH", verification_uri: "https://x.ai/activate", expires_in: 60, interval: 1 });
      return calls.filter((x) => x.endsWith("/oauth2/token")).length === 1
        ? Response.json({ error: "authorization_pending" }, { status: 400 })
        : Response.json({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600, scope: "api:access" });
    };
    const notes: string[] = [];
    const saved = await signInXAI({ file, fetch: fetcher, sleep: async () => undefined, write: (x) => notes.push(x) });
    expect(saved.accessToken).toBe("xai-access");
    expect(saved.refreshToken).toBe("xai-refresh");
    expect(notes.join("")).toContain("ABCD-EFGH");
    expect(calls).toContain("https://auth.x.ai/.well-known/openid-configuration");
  });

  it("stops on declined consent and expired device codes", async () => {
    const file = path.join(await temp(), "oauth.json");
    const makeFetcher = (error: string): typeof fetch => async (input) => String(input).endsWith("openid-configuration")
      ? Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"], scopes_supported: ["api:access", "offline_access"] })
      : String(input).endsWith("device/code") ? Response.json({ device_code: "d", user_code: "U", verification_uri: "https://x.ai/activate", expires_in: 2, interval: 1 })
        : Response.json({ error }, { status: 400 });
    await expect(signInXAI({ file, fetch: makeFetcher("access_denied"), sleep: async () => undefined, write: () => undefined })).rejects.toThrow("declined");
    await expect(signInXAI({ file, fetch: makeFetcher("expired_token"), sleep: async () => undefined, write: () => undefined })).rejects.toThrow("expired");
    expect(await readOAuthCredentials(file)).toEqual([]);
  });

  it("honors slow_down by increasing the interval and accepts the official auth.x.ai activation host", async () => {
    const file = path.join(await temp(), "oauth.json");
    const calls: string[] = [], intervals: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"], scopes_supported: ["api:access", "offline_access"] });
      if (url.endsWith("device/code")) return Response.json({ device_code: "d", user_code: "U", verification_uri: "https://auth.x.ai/activate", expires_in: 60, interval: 1 });
      const poll = calls.filter((x) => x.endsWith("/oauth2/token")).length;
      return poll === 1 ? Response.json({ error: "authorization_pending" }, { status: 400 }) : poll === 2 ? Response.json({ error: "slow_down" }, { status: 400 }) : Response.json({ access_token: "access", refresh_token: "refresh", scope: "api:access" });
    };
    await signInXAI({ file, fetch: fetcher, sleep: async (ms) => { intervals.push(ms); }, write: () => undefined });
    expect(intervals).toEqual([1000, 1000, 6000]);
  });

  it("cancels device polling promptly", async () => {
    const controller = new AbortController();
    const fetcher: typeof fetch = async (input) => String(input).endsWith("openid-configuration")
      ? Response.json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code", grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"], scopes_supported: ["api:access", "offline_access"] })
      : String(input).endsWith("device/code") ? Response.json({ device_code: "d", user_code: "U", verification_uri: "https://x.ai/activate", expires_in: 60, interval: 1 }) : Response.json({ error: "authorization_pending" }, { status: 400 });
    await expect(signInXAI({ file: path.join(await temp(), "cancel.json"), fetch: fetcher, signal: controller.signal, sleep: async () => { controller.abort(); }, write: () => undefined })).rejects.toThrow("cancelled");
  });
});

describe("OpenAI Sign in with ChatGPT", () => {
  it("uses PKCE loopback registration and verifies the ID token before saving", async () => {
    const file = path.join(await temp(), "oauth.json");
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const kid = "test-key";
    let nonce = "";
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json" });
      if (url.endsWith("jwks.json")) return Response.json({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
      if (url.endsWith("/oauth/token")) {
        const body = String(init?.body);
        expect(body).toContain("code_verifier=");
        return Response.json({ access_token: "openai-access", refresh_token: "openai-refresh", id_token: makeIdToken(pair.privateKey, kid, nonce), token_type: "Bearer", expires_in: 3600, scope: "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct" });
      }
      throw new Error("unexpected mock fetch");
    };
    let returnCode!: (value: { state: string; client_id: string; code: string }) => void;
    const signIn = signInOpenAI({ appName: "Chivgent", file, fetch: fetcher,
      startCallback: async () => ({ redirectUri: "http://127.0.0.1:1455/auth/callback", result: new Promise((resolve) => { returnCode = resolve; }), close: () => undefined }),
      openBrowser: async (url) => {
      const auth = new URL(url); nonce = auth.searchParams.get("nonce") ?? "";
      expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
      returnCode({ state: auth.searchParams.get("state")!, client_id: "oaiapp_test", code: "auth-code" });
    } });
    const result = await signIn;
    expect(result.accessToken).toBe("openai-access");
    expect(result.scopes).toContain("chatgpt.tokens.use.direct");
    expect((await readOAuthCredentials(file))[0]?.subject).toBe("subject-1");
    expect(nonce.length).toBeGreaterThan(10);
  });

  it("rejects a callback with a mismatched state before token exchange", async () => {
    const file = path.join(await temp(), "oauth.json");
    const call = signInOpenAI({ appName: "Chivgent", file, fetch: async () => { throw new Error("must not exchange a code"); },
      startCallback: async () => ({ redirectUri: "http://127.0.0.1:1455/auth/callback", result: Promise.resolve({ state: "wrong", client_id: "oaiapp_test", code: "code" }), close: () => undefined }),
      openBrowser: async () => undefined });
    await expect(call).rejects.toThrow("state validation failed");
  });

  it("rejects nonce and signature mismatches", async () => {
    await expect(attemptOpenAI(path.join(await temp(), "nonce.json"), { nonce: "wrong" })).rejects.toThrow("ID token validation failed");
    await expect(attemptOpenAI(path.join(await temp(), "signature.json"), { corruptSignature: true })).rejects.toThrow("ID token validation failed");
  });

  it("keeps the stored registration when a returning sign-in resolves to another subject", async () => {
    const file = path.join(await temp(), "subject.json");
    const prior: OAuthCredential = { type: "oauth", provider: "openai", clientId: "oaiapp_test", accessToken: "prior", refreshToken: "prior-refresh", idToken: "prior-id", expiresAt: Date.now() + 10000, scopes: ["offline_access"], subject: "other-subject" };
    await writeOAuthCredential(prior, file);
    await expect(attemptOpenAI(file, {})).rejects.toThrow("different account");
    expect((await readOAuthCredentials(file))[0]?.accessToken).toBe("prior");
  });
});

async function attemptOpenAI(file: string, options: { nonce?: string; corruptSignature?: boolean }): Promise<OAuthCredential> {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
  let nonce = "";
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json" });
    if (url.endsWith("jwks.json")) return Response.json({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
    let idToken = makeIdToken(pair.privateKey, "test-key", options.nonce ?? nonce);
    if (options.corruptSignature) {
      const [header, payload, signature] = idToken.split(".");
      const bytes = Buffer.from(signature!, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      idToken = `${header}.${payload}.${bytes.toString("base64url")}`;
    }
    return Response.json({ access_token: "access", refresh_token: "refresh", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct" });
  };
  let callback!: (value: { state: string; client_id: string; code: string }) => void;
  return signInOpenAI({ appName: "Chivgent", file, fetch: fetcher,
    startCallback: async () => ({ redirectUri: "http://127.0.0.1:1455/auth/callback", result: new Promise((resolve) => { callback = resolve; }), close: () => undefined }),
    openBrowser: async (url) => { const auth = new URL(url); nonce = auth.searchParams.get("nonce")!; callback({ state: auth.searchParams.get("state")!, client_id: "oaiapp_test", code: "code" }); },
  });
}

function makeIdToken(privateKey: KeyObject, kid: string, nonce: string): string {
  const enc = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const payload = enc({ iss: "https://auth.openai.com", aud: "oaiapp_test", exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: "subject-1", email: "user@example.com" });
  const signer = createSign("RSA-SHA256"); signer.update(`${head}.${payload}`); signer.end();
  return `${head}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}
