import type { LLMClient, LLMRequest, LLMResponse, LLMStreamHandlers } from "../llm.js";
import { refreshSavedOAuthCredential, type OAuthCredential } from "../auth/oauth.js";
import { defaultProviderRegistry } from "./registry.js";
import { oauthApiFetch } from "../auth/oauth.js";

/** Resolves rotating bearer tokens before every request, including long sessions. */
export class OAuthRefreshingLLMClient implements LLMClient {
  constructor(private readonly provider: OAuthCredential["provider"], private readonly model: string, private readonly file?: string) {}

  private async current(signal?: AbortSignal): Promise<LLMClient> {
    const credential = await refreshSavedOAuthCredential(this.provider, this.file, fetch, signal);
    if (!credential) throw new Error(`No ${this.provider} OAuth session is saved. Run /login oauth ${this.provider}.`);
    if (this.provider === "openai") {
      const definition = defaultProviderRegistry.get("openai");
      if (!definition.createOAuthClient) throw new Error("OpenAI subscription OAuth is not configured.");
      return definition.createOAuthClient({ apiKey: credential.accessToken, model: this.model });
    }
    return defaultProviderRegistry.get("xai").createClient({ apiKey: credential.accessToken, model: this.model,
      baseURL: "https://api.x.ai/v1", fetch: oauthApiFetch("https://api.x.ai") });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const client = await this.current(request.signal);
    try { return await client.complete(request); }
    catch (error) { throw safeOAuthRequestError(error, request.signal); }
  }
  async stream(request: LLMRequest, handlers: LLMStreamHandlers): Promise<LLMResponse> {
    const client = await this.current(request.signal);
    try {
      return client.stream ? await client.stream(request, handlers) : await client.complete(request);
    } catch (error) { throw safeOAuthRequestError(error, request.signal); }
  }
  cancel(): void { /* Requests use the caller's AbortSignal; no shared request state. */ }
}

function safeOAuthRequestError(_error: unknown, signal?: AbortSignal): Error {
  return signal?.aborted
    ? new Error("OAuth provider request was cancelled.")
    : new Error("OAuth provider request failed. Check the provider session and network, then retry.");
}
