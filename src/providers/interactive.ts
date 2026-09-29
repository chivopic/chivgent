import type { CliOptions } from "../cli-options.js";
import { CredentialResolver } from "../auth/credentials.js";
import { EnvCredentialSource } from "../auth/env-credentials.js";
import { defaultAuthFile, FileCredentialSource, writeApiKey } from "../auth/file-credentials.js";
import { RuntimeCredentialSource } from "../auth/runtime-credentials.js";
import type { SignIn, ProviderControl, ProviderSelection } from "../repl.js";
import { createConfiguredClient } from "./client.js";
import { DeferredLLMClient } from "./deferred-client.js";
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
    return (await this.credentialResolver(this.active.provider).resolve(this.registry.get(this.active.provider))) === undefined;
  }
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
      if (this.active.provider === this.options.provider) this.ignoreStartupKey = true;
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
    let client;
    try {
      client = await createConfiguredClient(this.clientOptions(choice), this.registry, this.credentialResolver(id));
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
