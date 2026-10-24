import type { CliOptions } from "../cli-options.js";
import { DEFAULT_CONTEXT_WINDOW, type AppliedCompaction } from "../context/context-manager.js";
import { createLocalSession } from "../cli-runtime.js";
import { CredentialResolver } from "../auth/credentials.js";
import { EnvCredentialSource } from "../auth/env-credentials.js";
import { FileCredentialSource, defaultAuthFile } from "../auth/file-credentials.js";
import { RetryingLLMClient } from "../retry.js";
import { defaultProviderRegistry } from "../providers/registry.js";
import type { Message } from "../messages.js";
import { PermissionPolicy, type PermissionMode, type PermissionApproval } from "../permissions.js";

export interface DesktopRuntimeConfig {
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly authFile?: string;
  readonly messages?: readonly Message[];
  readonly compaction?: AppliedCompaction;
  readonly permissionMode?: "read-only" | PermissionMode;
  readonly approval?: PermissionApproval;
  readonly createClient?: (config: { apiKey: string; model: string; baseURL?: string }) => import("../llm.js").LLMClient;
}

export async function createDesktopSession(config: DesktopRuntimeConfig) {
  const environment = config.environment ?? process.env;
  const registry = defaultProviderRegistry;
  const provider = config.provider ?? environment.CHIVGENT_PROVIDER ?? "openai";
  const definition = registry.get(provider);
  const model = config.model ?? first(environment, definition.modelEnvKeys) ?? definition.defaultModel;
  if (model === undefined || model.length === 0) {
    throw new Error(`需要为 ${provider} 配置模型名称。`);
  }
  const baseURL = first(environment, definition.baseUrlEnvKeys) ?? definition.defaultBaseURL;
  if (definition.requiresBaseURL && baseURL === undefined) {
    throw new Error(`${definition.baseUrlEnvKeys.join(" 或 ")} 需要配置。`);
  }
  const credentialEnvironment = { ...environment };
  // Both Providers declare OPENAI_API_KEY, but they can target different
  // origins. Use the shared environment key only for its startup Provider;
  // after switching, use the destination Provider's own auth.json entry.
  const startupProvider = environment.CHIVGENT_PROVIDER ?? "openai";
  if ((provider === "openai-compatible" || provider === "openai") && provider !== startupProvider) {
    delete credentialEnvironment.OPENAI_API_KEY;
  }
  const credential = await new CredentialResolver([
    new EnvCredentialSource(credentialEnvironment),
    new FileCredentialSource(config.authFile ?? defaultAuthFile(environment)),
  ]).resolve(definition);
  if (credential === undefined) {
    throw new Error(`尚未配置 ${provider} API key。请设置 ${definition.envKeys.join(" 或 ")}，或在 CLI 的 auth.json 中配置。`);
  }
  const llm = new RetryingLLMClient(config.createClient === undefined
    ? definition.createClient({ apiKey: credential.apiKey, model, ...(baseURL === undefined ? {} : { baseURL }) })
    : config.createClient({ apiKey: credential.apiKey, model, ...(baseURL === undefined ? {} : { baseURL }) }));
  const options = {
    provider, model, ...(baseURL === undefined ? {} : { baseURL }),
    maxTurns: 8, stream: true, quiet: true, json: false, session: false,
    continueSession: false, listSessions: false, allowWrites: false, allowShell: false,
    approveAllShell: false, shellBackend: "auto", shellNetwork: false, tui: false, simple: false,
    extensions: false, listExtensions: false, forgetTrust: false, serve: false,
    listServers: false, contextWindow: DEFAULT_CONTEXT_WINDOW,
    compaction: true, help: false, version: false,
  } satisfies CliOptions;
  const session = createLocalSession({
    options, cwd: config.cwd, llm,
    ...(config.permissionMode === undefined || config.permissionMode === "read-only" ? {} : {
      permissionPolicy: new PermissionPolicy(config.permissionMode, config.approval),
      allowShellForPolicy: false,
    }),
    restored: { resumed: false, messages: config.messages,
      ...(config.compaction === undefined ? {} : { compaction: config.compaction }) },
  });
  return { session, provider, model, baseURL };
}

function first(environment: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = environment[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
