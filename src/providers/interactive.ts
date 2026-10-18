import type { CliOptions } from "../cli-options.js";
import path from "node:path";
import { CredentialResolver } from "../auth/credentials.js";
import { EnvCredentialSource } from "../auth/env-credentials.js";
import { defaultAuthFile, FileCredentialSource, writeApiKey } from "../auth/file-credentials.js";
import { RuntimeCredentialSource } from "../auth/runtime-credentials.js";
import { removeOAuthCredential, signInOpenAI, signInXAI, revokeOAuthCredential, readOAuthCredentials } from "../auth/oauth.js";
import type { SignIn, ProviderControl, ProviderSelection } from "../repl.js";
import { createConfiguredClient } from "./client.js";
import { DeferredLLMClient } from "./deferred-client.js";
import { OAuthRefreshingLLMClient } from "./oauth-client.js";
import { defaultProviderRegistry, type ProviderRegistry } from "./registry.js";

interface Choice {
  readonly provider: string;
  readonly model?: string;
  readonly baseURL?: string;
}

function firstValue(environment: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** The active Provider is mutable; the Agent and compactor keep the same LLM proxy. */
export class InteractiveProvider implements SignIn, ProviderControl {
  readonly authFile: string;
  private active: Choice;
  private readonly choices = new Map<string, Choice>();
  private ignoreStartupKey = false;
  private readonly oauthModes = new Set<"openai" | "xai">();

  constructor(
    private readonly options: CliOptions,
    private readonly llm: DeferredLLMClient,
    private readonly registry: ProviderRegistry = defaultProviderRegistry,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    authFile: string = defaultAuthFile(environment),
  ) {
    this.authFile = authFile;
    this.active = { provider: options.provider, ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }) };
    this.choices.set(options.provider, this.active);
  }

  get provider(): string { return this.active.provider; }
  get model(): string | undefined { return this.active.model; }
  ready(): boolean { return this.llm.ready; }
  providerIds(): readonly string[] { return this.registry.ids(); }
  async needsApiKey(): Promise<boolean> {
    if ((await this.credentialResolver(this.active.provider).resolve(this.registry.get(this.active.provider))) !== undefined) return false;
    if ((this.active.provider === "openai" || this.active.provider === "xai") && this.active.model !== undefined) {
      const saved = (await readOAuthCredentials(this.oauthFile)).find((item) => item.provider === this.active.provider);
      if (saved && (this.active.provider !== "xai" || this.active.baseURL === undefined || this.active.baseURL === "https://api.x.ai/v1")) return false;
    }
    return true;
  }

  async oauth(provider: "openai" | "xai", signal?: AbortSignal): Promise<string | undefined> {
    if (this.active.provider !== provider) return `Select ${provider} with /provider ${provider} before signing in.\n`;
    if (this.active.model === undefined) return `Set a model first with /model MODEL before signing in to ${provider}.\n`;
    if (provider === "xai" && this.active.baseURL !== undefined && this.active.baseURL !== "https://api.x.ai/v1") {
      return "xAI subscription OAuth cannot be used with a custom endpoint.\n";
    }
    try {
      if (provider === "openai") await signInOpenAI({ appName: "Chivgent", file: this.oauthFile, signal });
      else await signInXAI({ file: this.oauthFile, write: (text) => process.stderr.write(text), signal });
      let model = this.active.model;
      if (provider === "openai") {
        const credential = (await readOAuthCredentials(this.oauthFile)).find((item) => item.provider === provider);
        if (!credential) return "OAuth credential was not saved. Sign in again.\n";
        const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${credential.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`Could not load ChatGPT plan models (${response.status}).`);
        const body = await response.json() as { models?: Array<{ slug?: string; visibility?: string }> };
        const available = body.models?.filter((item) => item.visibility === "list" && typeof item.slug === "string").map((item) => item.slug as string) ?? [];
        if (!available.length) throw new Error("The signed-in ChatGPT account returned no available models.");
        if (!available.includes(model ?? "")) model = available[0]!;
        this.active = { ...this.active, model };
        this.choices.set(provider, this.active);
      }
      this.oauthModes.add(provider);
      this.llm.set(new OAuthRefreshingLLMClient(provider, model ?? "", this.oauthFile));
      return undefined;
    } catch (error: unknown) {
      return `${error instanceof Error ? error.message : "OAuth sign-in failed."}\n`;
    }
  }

  async signOut(): Promise<string | undefined> {
    const provider = this.active.provider;
    if (provider !== "openai" && provider !== "xai") return `No OAuth subscription is active for ${provider}.`;
    try {
      const saved = (await readOAuthCredentials(this.oauthFile)).find((item) => item.provider === provider);
      const revoked = saved === undefined ? true : await revokeOAuthCredential(saved);
      await removeOAuthCredential(provider, this.oauthFile);
      this.oauthModes.delete(provider);
      const replacement = await createConfiguredClient(this.clientOptions(this.active), this.registry, this.credentialResolver(provider), this.oauthFile);
      if (typeof replacement !== "string") this.llm.set(replacement);
      else this.llm.clear(replacement);
      return revoked ? `Signed out of ${provider} subscription.` : `Signed out locally; remote revocation was not confirmed. Disconnect this app in the provider's account settings.`;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : "Could not sign out.";
    }
  }

  private get oauthFile(): string { return path.join(path.dirname(this.authFile), "oauth.json"); }
  unavailableMessage(): string {
    const definition = this.registry.get(this.active.provider);
    const missing = [this.active.model === undefined ? "/model MODEL" : undefined,
      definition.requiresBaseURL && this.active.baseURL === undefined ? "/endpoint URL" : undefined]
      .filter(Boolean).join(" and ");
    return missing ? `Configure ${this.active.provider} with ${missing}.`
      : `No API key for ${this.active.provider}. Run /login or use /provider to switch.`;
  }

  describe(): string {
    const current = `${this.active.provider} / ${this.active.model ?? "model needed"}`;
    const entries = this.registry.ids().map((id) => {
      const definition = this.registry.get(id);
      const model = this.choices.get(id)?.model ?? firstValue(this.environment, definition.modelEnvKeys)
        ?? definition.defaultModel ?? "model required";
      const configuredURL = this.choices.get(id)?.baseURL ?? firstValue(this.environment, definition.baseUrlEnvKeys)
        ?? definition.defaultBaseURL;
      const url = definition.requiresBaseURL && configuredURL === undefined ? ", base URL required" : "";
      return `  ${id === this.active.provider ? "●" : " "} ${id.padEnd(18)}${model}${url}`;
    });
    return `Current: ${current}${this.llm.ready ? " · ready" : " · setup needed"}\n${entries.join("\n")}\nUse /provider NAME to switch, /model MODEL to set its model, /endpoint URL for a custom endpoint, and /login for its key.\n`;
  }

  async select(argument: string): Promise<ProviderSelection> {
    const id = argument.trim();
    if (!this.registry.has(id)) {
      return { ok: false, message: "Unknown Provider. Use /provider to see the available choices.\n" };
    }
    return this.configure(id);
  }

  async changeModel(model: string): Promise<ProviderSelection> {
    const value = model.trim();
    if (value.length === 0 || /\s/.test(value)) {
      return { ok: false, message: "Use /model MODEL (one model id).\n" };
    }
    return this.configure(this.active.provider, value, this.active.baseURL);
  }

  async changeEndpoint(baseURL: string): Promise<ProviderSelection> {
    const value = baseURL.trim();
    if (!this.registry.get(this.active.provider).requiresBaseURL) {
      return { ok: false, message: "The current Provider has a built-in endpoint. Switch to openai-compatible first.\n" };
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      return { ok: false, message: "Use /endpoint with an http:// or https:// URL.\n" };
    }
    return this.configure(this.active.provider, this.active.model, value);
  }

  async submit(apiKey: string): Promise<string | undefined> {
    const definition = this.registry.get(this.active.provider);
    if (this.active.model === undefined || (definition.requiresBaseURL && this.active.baseURL === undefined)) {
      try {
        await writeApiKey(this.active.provider, apiKey, this.authFile);
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
      if (this.active.provider === "openai" || this.active.provider === "xai") this.oauthModes.delete(this.active.provider);
      if (this.active.provider === this.options.provider) this.ignoreStartupKey = true;
      this.llm.clear(`Configure ${this.active.provider} before using its API key.`);
      return undefined;
    }
    const nextOptions = this.clientOptions(this.active, apiKey);
    let client;
    try {
      client = await createConfiguredClient(nextOptions, this.registry, new CredentialResolver([
        new RuntimeCredentialSource(apiKey),
      ]));
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    if (typeof client === "string") return client;
    try {
      await writeApiKey(this.active.provider, apiKey, this.authFile);
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    if (this.active.provider === "openai" || this.active.provider === "xai") this.oauthModes.delete(this.active.provider);
    if (this.active.provider === this.options.provider) this.ignoreStartupKey = true;
    this.llm.set(client);
    return undefined;
  }

  private async configure(id: string, requestedModel?: string, requestedBaseURL?: string): Promise<ProviderSelection> {
    const definition = this.registry.get(id);
    const previous = this.choices.get(id);
    const model = requestedModel ?? previous?.model ?? firstValue(this.environment, definition.modelEnvKeys)
      ?? definition.defaultModel;
    const baseURL = requestedBaseURL ?? previous?.baseURL ?? firstValue(this.environment, definition.baseUrlEnvKeys)
      ?? definition.defaultBaseURL;
    const choice: Choice = { provider: id, model, ...(baseURL === undefined ? {} : { baseURL }) };
    if (model === undefined || (definition.requiresBaseURL && baseURL === undefined)) {
      this.active = choice;
      this.choices.set(id, choice);
      const missing = [model === undefined ? "/model MODEL" : undefined,
        definition.requiresBaseURL && baseURL === undefined ? "/endpoint URL" : undefined].filter(Boolean).join(" and ");
      this.llm.clear(`Configure ${id} with ${missing}.`);
      return { ok: true, message: `Selected ${id}. Set ${missing} to continue.\n` };
    }
    if ((id === "openai" || id === "xai") && this.oauthModes.has(id)) {
      if (id === "xai" && baseURL !== undefined && baseURL !== "https://api.x.ai/v1") {
        return { ok: false, message: "xAI subscription OAuth cannot be used with a custom endpoint.\n" };
      }
      this.active = choice;
      this.choices.set(id, choice);
      this.llm.set(new OAuthRefreshingLLMClient(id, model, this.oauthFile));
      return { ok: true, message: `Selected ${id} subscription / ${model}.\n` };
    }
    let client;
    try {
      client = await createConfiguredClient(this.clientOptions(choice), this.registry, this.credentialResolver(id), this.oauthFile);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not select ${id}: ${message}\n` };
    }
    if (typeof client === "string" && !client.startsWith(`No API key for ${id}.`)) {
      return { ok: false, message: `Could not select ${id}: ${client}\n` };
    }
    this.active = choice;
    this.choices.set(id, choice);
    if (typeof client === "string") {
      const guidance = `API key needed for ${id}.`;
      this.llm.clear(guidance);
      return { ok: true, message: `Selected ${id} / ${model}. ${guidance}\n` };
    }
    this.llm.set(client);
    return { ok: true, message: `Selected ${id} / ${model}. Ready for your next prompt.\n` };
  }

  private credentialResolver(id: string): CredentialResolver {
    // A switched compatible endpoint must not inherit OpenAI's own API key.
    const credentialEnvironment = id === "openai-compatible" && this.options.provider !== id
      ? { ...this.environment, OPENAI_API_KEY: undefined }
      : this.environment;
    return new CredentialResolver([
      new RuntimeCredentialSource(id === this.options.provider && !this.ignoreStartupKey ? this.options.apiKey : undefined),
      new EnvCredentialSource(credentialEnvironment),
      new FileCredentialSource(this.authFile),
    ]);
  }

  private clientOptions(choice: Choice, apiKey?: string): CliOptions {
    const { apiKey: _startupKey, model: _startupModel, baseURL: _startupURL, ...rest } = this.options;
    return { ...rest, provider: choice.provider, ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.baseURL === undefined ? {} : { baseURL: choice.baseURL }),
      ...(apiKey === undefined ? {} : { apiKey }) };
  }
}
