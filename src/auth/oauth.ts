import { createServer, type Server } from "node:http";
import { randomBytes, createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, rename, chmod, writeFile, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** OAuth credentials have a separate schema and lifecycle from API keys. */
export interface OAuthCredential {
  readonly type: "oauth";
  readonly provider: "openai" | "xai";
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly subject?: string;
  readonly email?: string;
}

export function oauthFilePath(home = process.env.CHIVGENT_HOME): string {
  return path.join(home || path.join(os.homedir(), ".chivgent"), "oauth.json");
}

const fileLocks = new Map<string, Promise<void>>();
async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  fileLocks.set(file, queued);
  await previous;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lockPath = `${file}.lock`;
    const deadline = Date.now() + 30_000;
    while (!lockHandle && Date.now() < deadline) {
      try { lockHandle = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!lockHandle) throw new Error(`OAuth credentials are busy in another chivgent process (lock: ${lockPath}); retry shortly. If no process is using it, remove the stale lock file.`);
    return await action();
  }
  finally {
    if (lockHandle) { await lockHandle.close(); await unlink(`${file}.lock`).catch(() => undefined); }
    release(); if (fileLocks.get(file) === queued) fileLocks.delete(file);
  }
}

export async function readOAuthCredentials(file = oauthFilePath()): Promise<OAuthCredential[]> {
  try {
    const text = await readFile(file, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error(`The OAuth credential file at ${file} is not valid JSON.`); }
    if (!Array.isArray(parsed)) throw new Error("OAuth credential file must be an array.");
    if (parsed.some((item) => !isCredential(item))) throw new Error(`The OAuth credential file at ${file} contains an invalid record; refusing to ignore credentials silently.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeOAuthCredential(credential: OAuthCredential, file = oauthFilePath()): Promise<void> {
  return withFileLock(file, async () => writeOAuthCredentialUnlocked(credential, file));
}

async function writeOAuthCredentialUnlocked(credential: OAuthCredential, file: string): Promise<void> {
  const current = await readOAuthCredentials(file);
  const next = current.filter((item) => item.provider !== credential.provider);
  next.push(credential);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
}

export async function removeOAuthCredential(provider: OAuthCredential["provider"], file = oauthFilePath()): Promise<void> {
  return withFileLock(file, async () => removeOAuthCredentialUnlocked(provider, file));
}

async function removeOAuthCredentialUnlocked(provider: OAuthCredential["provider"], file: string): Promise<void> {
  const current = await readOAuthCredentials(file);
  const next = current.filter((item) => item.provider !== provider);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
}

export async function refreshSavedOAuthCredential(provider: OAuthCredential["provider"], file = oauthFilePath(), fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OAuthCredential | undefined> {
  signal?.throwIfAborted();
  return withFileLock(file, async () => {
    signal?.throwIfAborted();
    const current = (await readOAuthCredentials(file)).find((item) => item.provider === provider);
    if (!current) return undefined;
    if (current.expiresAt >= Date.now() + 60_000) return current;
    const refreshed = await refreshOAuthCredential(current, fetcher, signal);
    const latest = (await readOAuthCredentials(file)).find((item) => item.provider === provider);
    if (!latest || latest.refreshToken !== current.refreshToken || latest.clientId !== current.clientId) throw new Error("OAuth session changed during refresh; sign in again.");
    await writeOAuthCredentialUnlocked(refreshed, file);
    return refreshed;
  });
}

export async function refreshOAuthCredential(credential: OAuthCredential, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OAuthCredential> {
  if (!credential.refreshToken) throw new Error(`No refresh token is available for ${credential.provider}; sign in again.`);
  const endpoint = credential.provider === "openai"
    ? "https://auth.openai.com/api/accounts/oauth/token"
    : await getXaiTokenEndpoint(fetcher, signal);
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: credential.clientId,
    refresh_token: credential.refreshToken, ...(credential.provider === "openai" ? { resource: "https://api.openai.com/v1" } : {}) });
  const response = await secureFetch(fetcher, signal)(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const data = await safeJson<TokenResponse>(response, "OAuth refresh");
  if (!response.ok || !data.access_token) throw new Error(`OAuth refresh failed (${safeError(data.error)}); sign in again if the session was revoked.`);
  validateTokenFields(data, credential.provider, false);
  return { ...credential, accessToken: data.access_token, refreshToken: data.refresh_token ?? credential.refreshToken,
    idToken: data.id_token ?? credential.idToken, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scopes: data.scope?.split(" ").filter(Boolean) ?? credential.scopes };
}

async function getXaiTokenEndpoint(fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const response = await secureFetch(fetcher, signal)("https://auth.x.ai/.well-known/openid-configuration");
  if (!response.ok) throw new Error("Could not load xAI OAuth metadata for token refresh.");
  const metadata = await safeJson<{ issuer?: string; token_endpoint?: string }>(response, "xAI OAuth metadata");
  if (metadata.issuer !== "https://auth.x.ai" || metadata.token_endpoint !== "https://auth.x.ai/oauth2/token") throw new Error("xAI OAuth token endpoint failed metadata validation.");
  return metadata.token_endpoint;
}

export async function revokeOAuthCredential(credential: OAuthCredential, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!credential.refreshToken) return false;
  try {
    const safeFetch = secureFetch(fetcher);
    const issuer = credential.provider === "openai" ? "https://auth.openai.com" : "https://auth.x.ai";
    const discovery = await safeFetch(`${issuer}/.well-known/openid-configuration`);
    if (!discovery.ok) return false;
    const metadata = await discovery.json() as { revocation_endpoint?: string };
    if (!metadata.revocation_endpoint || new URL(metadata.revocation_endpoint).origin !== issuer) return false;
    const response = await safeFetch(metadata.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: "refresh_token", client_id: credential.clientId }) });
    return response.status === 200;
  } catch { return false; }
}

interface TokenResponse { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; token_type?: string; scope?: string; error?: string }
const SAFE_OAUTH_ERRORS = new Set(["access_denied", "authorization_pending", "slow_down", "expired_token", "invalid_grant", "invalid_client", "invalid_request", "server_error", "temporarily_unavailable"]);
function safeError(value?: string): string { return value && SAFE_OAUTH_ERRORS.has(value) ? value : "oauth_error"; }
async function safeJson<T>(response: Response, label: string): Promise<T> {
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch { throw new Error(`Could not parse ${label} response.`); }
}
function validateTokenFields(token: TokenResponse, provider: OAuthCredential["provider"], requireOpenAIRenewal: boolean): void {
  if (typeof token.access_token !== "string" || !token.access_token.trim() ||
      [token.refresh_token, token.id_token, token.scope].some(value => value !== undefined && typeof value !== "string")) {
    throw new Error("OAuth returned invalid credential fields.");
  }
  if (token.token_type !== undefined && (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer")) throw new Error("OAuth returned an unsupported token type.");
  if (token.expires_in !== undefined && (!Number.isFinite(token.expires_in) || token.expires_in <= 0)) throw new Error("OAuth returned an invalid token lifetime.");
  if (requireOpenAIRenewal && (token.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(token.expires_in) || (token.expires_in ?? 0) <= 0 || !token.refresh_token || !token.scope?.split(" ").includes("offline_access"))) throw new Error("OpenAI did not grant renewable offline access.");
}
function isCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "oauth" && (v.provider === "openai" || v.provider === "xai") &&
    typeof v.clientId === "string" && v.clientId.length > 0 && typeof v.accessToken === "string" && v.accessToken.length > 0 &&
    typeof v.expiresAt === "number" && Number.isFinite(v.expiresAt) &&
    Array.isArray(v.scopes) && v.scopes.every(scope => typeof scope === "string") &&
    [v.refreshToken, v.idToken, v.subject, v.email].every(value => value === undefined || typeof value === "string");
}

function b64url(bytes: Buffer): string { return bytes.toString("base64url"); }
function randomValue(): string { return b64url(randomBytes(32)); }

/** Current OpenAI OSS SIWC registration flow; callback remains loopback-only. */
export async function signInOpenAI(options: { appName: string; file?: string; openBrowser?: (url: string) => Promise<void>; fetch?: typeof fetch; signal?: AbortSignal; startCallback?: (state: string) => Promise<{ redirectUri: string; result: Promise<CallbackResult>; close(): void }> }): Promise<OAuthCredential> {
  options.signal?.throwIfAborted();
  const fetcher = secureFetch(options.fetch ?? fetch, options.signal);
  const hostId = await getOrCreateHostId(options.file);
  const previous = (await readOAuthCredentials(options.file)).find((item) => item.provider === "openai");
  const state = randomValue(), nonce = randomValue(), verifier = randomValue();
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const callback = await (options.startCallback?.(state) ?? listenForCallback(state, options.signal));
  const auth = new URL("https://auth.openai.com/api/accounts/authorize");
  const authFields: Record<string, string> = { client_id: previous?.clientId ?? "dynamic_agent_client",
    ext_agent_host_id: hostId, response_type: "code", redirect_uri: callback.redirectUri,
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1", state, nonce, code_challenge_method: "S256", code_challenge: challenge };
  if (previous === undefined) authFields.agent_name_hint = options.appName;
  else {
    if (previous.idToken) authFields.id_token_hint = previous.idToken;
    if (previous.email) authFields.login_hint = previous.email;
  }
  for (const [k,v] of Object.entries(authFields)) auth.searchParams.set(k,v);
  try {
    if (options.openBrowser) await options.openBrowser(auth.toString());
    else await openBrowser(auth.toString());
    const result = await callback.result;
    if (result.state !== state) throw new Error("OAuth state validation failed.");
    const clientId = result.client_id ?? previous?.clientId;
    if (result.error) throw new Error(result.error === "access_denied" ? "Sign-in was declined." : `OpenAI authorization failed (${safeError(result.error)}).`);
    if (previous && result.client_id && result.client_id !== previous.clientId) throw new Error("OpenAI returned a different client ID than the selected registration.");
    if (!clientId?.startsWith("oaiapp_") || !result.code) throw new Error("OpenAI registration did not return an issued client ID and authorization code.");
    const response = await fetcher("https://auth.openai.com/api/accounts/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: result.code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: "https://api.openai.com/v1" }) });
    const token = await safeJson<TokenResponse>(response, "OpenAI token exchange");
    if (!response.ok || !token.access_token || !token.id_token) throw new Error(`OpenAI token exchange failed (${safeError(token.error)}).`);
    validateTokenFields(token, "openai", true);
    if (!token.scope?.split(" ").includes("resource.invoke") || !token.scope.split(" ").includes("chatgpt.tokens.use.direct")) throw new Error("Required ChatGPT plan usage permissions were not granted.");
    const identity = await verifyOpenAIIdToken(token.id_token, clientId, nonce, fetcher);
    if (previous?.subject && previous.subject !== identity.sub) throw new Error("OpenAI sign-in returned a different account than the selected registration.");
    const credential: OAuthCredential = { type: "oauth", provider: "openai", clientId, accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), idToken: token.id_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000, scopes: token.scope!.split(" "), subject: identity.sub as string,
      ...(typeof identity.email === "string" ? { email: identity.email } : {}) };
    await writeOAuthCredential(credential, options.file);
    return credential;
  } finally { callback.close(); }
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

interface CallbackResult { code?: string; state?: string; client_id?: string; error?: string }
async function listenForCallback(expectedState: string, signal?: AbortSignal): Promise<{ redirectUri: string; result: Promise<CallbackResult>; close(): void }> {
  signal?.throwIfAborted();
  let resolve!: (value: CallbackResult) => void, reject!: (error: Error) => void;
  const result = new Promise<CallbackResult>((res, rej) => { resolve = res; reject = rej; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
    const state = url.searchParams.get("state") ?? undefined;
    if (state !== expectedState) { response.writeHead(400).end("Invalid OAuth state."); reject(new Error("OAuth state validation failed.")); return; }
    const value: CallbackResult = { state, code: url.searchParams.get("code") ?? undefined, client_id: url.searchParams.get("client_id") ?? undefined, error: url.searchParams.get("error") ?? undefined };
    response.writeHead(value.error ? 400 : 200, { "content-type": "text/plain" }).end(value.error === "access_denied" ? "Sign-in was declined. You may close this window." : "Sign-in received. You may close this window.");
    if (value.error) reject(new Error(value.error === "access_denied" ? "Sign-in was declined." : `OpenAI authorization failed (${safeError(value.error)}).`)); else resolve(value);
  });
  const timer = setTimeout(() => reject(new Error("OpenAI sign-in timed out. Run /login oauth openai to try again.")), 5 * 60_000);
  timer.unref();
  const abort = (): void => reject(new Error("OpenAI sign-in was cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the local OAuth callback listener.");
  return { redirectUri: `http://127.0.0.1:${address.port}/auth/callback`, result, close: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); server.close(); } };
}

async function getOrCreateHostId(file?: string): Promise<string> {
  const target = file ?? oauthFilePath();
  const hostFile = path.join(path.dirname(target), "oauth-host-id");
  try { return (await readFile(hostFile, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    await mkdir(path.dirname(hostFile), { recursive: true, mode: 0o700 });
    await writeFile(hostFile, `${id}\n`, { mode: 0o600, flag: "wx" });
    return id;
  }
}

async function verifyOpenAIIdToken(token: string, audience: string, nonce: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const [head, payload, signature] = token.split(".");
  if (!head || !payload || !signature || token.split(".").length !== 3) throw new Error("OpenAI returned a malformed ID token.");
  let header: { kid?: string; alg?: string };
  try { header = JSON.parse(Buffer.from(head, "base64url").toString()) as { kid?: string; alg?: string }; }
  catch { throw new Error("OpenAI returned a malformed ID token."); }
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>; }
  catch { throw new Error("OpenAI returned a malformed ID token."); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("OpenAI ID token uses an unsupported signing key.");
  const discoveryResponse = await fetcher("https://auth.openai.com/.well-known/openid-configuration");
  if (!discoveryResponse.ok) throw new Error("Could not load OpenAI identity metadata.");
  const discovery = await safeJson<{ issuer?: string; jwks_uri?: string }>(discoveryResponse, "OpenAI identity metadata");
  if (discovery.issuer !== "https://auth.openai.com" || !discovery.jwks_uri || new URL(discovery.jwks_uri).origin !== "https://auth.openai.com") throw new Error("OpenAI identity metadata failed validation.");
  const jwksResponse = await fetcher(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error("Could not verify OpenAI ID token signing key.");
  const jwks = await safeJson<{ keys?: Array<JsonWebKey & { kid?: string }> }>(jwksResponse, "OpenAI signing keys");
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("OpenAI ID token signing key was not found.");
  let valid = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    valid = verifySignature("RSA-SHA256", Buffer.from(`${head}.${payload}`), key, Buffer.from(signature, "base64url"));
  } catch { throw new Error("OpenAI ID token signature validation failed."); }
  const aud = claims.aud;
  if (!valid || claims.iss !== discovery.issuer || !(aud === audience || (Array.isArray(aud) && aud.includes(audience) && claims.azp === audience)) || claims.nonce !== nonce || typeof claims.exp !== "number" || claims.exp <= Date.now() / 1000 || (typeof claims.nbf === "number" && claims.nbf > Date.now() / 1000) || typeof claims.sub !== "string") throw new Error("OpenAI ID token validation failed.");
  return claims;
}

/** xAI RFC 8628 device login; endpoints/scopes currently follow public grok-cli OAuth metadata. */
export async function signInXAI(options: { file?: string; write: (text: string) => void; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal }): Promise<OAuthCredential> {
  options.signal?.throwIfAborted();
  const fetcher = secureFetch(options.fetch ?? fetch, options.signal);
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  const discoveryResponse = await fetcher("https://auth.x.ai/.well-known/openid-configuration");
  if (!discoveryResponse.ok) throw new Error("Could not load xAI OAuth metadata.");
  const discovery = await safeJson<{ issuer?: string; token_endpoint?: string; device_authorization_endpoint?: string; grant_types_supported?: string[]; scopes_supported?: string[] }>(discoveryResponse, "xAI OAuth metadata");
  const tokenEndpoint = "https://auth.x.ai/oauth2/token";
  const deviceEndpoint = "https://auth.x.ai/oauth2/device/code";
  if (discovery.issuer !== "https://auth.x.ai" || discovery.token_endpoint !== tokenEndpoint || discovery.device_authorization_endpoint !== deviceEndpoint || !discovery.grant_types_supported?.includes("urn:ietf:params:oauth:grant-type:device_code") || !discovery.scopes_supported?.includes("api:access") || !discovery.scopes_supported.includes("offline_access")) throw new Error("xAI OAuth metadata does not advertise the expected device-code flow and scopes.");
  const response = await fetcher(discovery.device_authorization_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: clientId, scope: "openid profile email offline_access grok-cli:access api:access", referrer: "chivgent" }) });
  const device = await safeJson<{ device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string }>(response, "xAI device authorization");
  if (!response.ok || !device.device_code || !device.user_code || !device.verification_uri) throw new Error(`xAI device authorization failed (${safeError(device.error)}).`);
  const verification = new URL(device.verification_uri);
  if (verification.protocol !== "https:" || !["x.ai", "auth.x.ai"].includes(verification.hostname) || verification.username || verification.password || /[\u0000-\u001f\u007f]/.test(device.verification_uri)) throw new Error("xAI returned an unexpected device verification URL.");
  options.write(`Open ${device.verification_uri} and enter code ${device.user_code}\n`);
  const expires = Date.now() + (device.expires_in ?? 900) * 1000;
  let interval = device.interval ?? 5;
  const delay = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < expires) {
    if (options.signal?.aborted) throw new Error("xAI sign-in was cancelled.");
    await abortableDelay(interval * 1000, delay, options.signal);
    const polled = await fetcher(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: device.device_code }) });
    const token = await safeJson<TokenResponse>(polled, "xAI token polling");
    if (polled.ok && token.access_token) {
      validateTokenFields(token, "xai", false);
      const granted = token.scope?.split(" ") ?? [];
      if (!token.refresh_token || (!granted.includes("api:access") && !granted.includes("grok-cli:access"))) throw new Error("xAI did not grant renewable Grok API access.");
      const credential: OAuthCredential = { type: "oauth", provider: "xai", clientId, accessToken: token.access_token, ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000, scopes: token.scope?.split(" ") ?? [] };
      await writeOAuthCredential(credential, options.file); return credential;
    }
    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") { interval += 5; continue; }
    if (token.error === "access_denied") throw new Error("xAI sign-in was declined.");
    if (token.error === "expired_token") throw new Error("xAI device code expired. Run /login xai again.");
    if (!polled.ok) throw new Error(`xAI token polling failed (${safeError(token.error)}).`);
  }
  throw new Error("xAI device code expired. Run /login xai again.");
}

async function abortableDelay(ms: number, delay: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return delay(ms);
  if (signal.aborted) throw new Error("xAI sign-in was cancelled.");
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(new Error("xAI sign-in was cancelled.")); signal.addEventListener("abort", cancel, { once: true }); });
  try { await Promise.race([delay(ms), aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
}

function secureFetch(fetcher: typeof fetch, outerSignal?: AbortSignal): typeof fetch {
  return (input, init = {}) => fetcher(input, { ...init, redirect: "error", signal: AbortSignal.any([...(init.signal ? [init.signal] : []), ...(outerSignal ? [outerSignal] : []), AbortSignal.timeout(15_000)]) });
}

/** OAuth bearer tokens may only reach their provider API; reject redirects too. */
export function oauthApiFetch(expectedOrigin: string): typeof fetch {
  return (input, init = {}) => {
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)); }
    catch { throw new Error("OAuth API request had an invalid URL."); }
    if (url.origin !== expectedOrigin) throw new Error("OAuth API request target failed origin validation.");
    return fetch(input, { ...init, redirect: "error" });
  };
}
