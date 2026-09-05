import type { CliOptions } from "../cli-options.js";
import type { LLMClient } from "../llm.js";
import { RetryingLLMClient } from "../retry.js";
import { defaultProviderRegistry, ProviderRegistry } from "./registry.js";
import { CredentialResolver } from "../auth/credentials.js";
import { RuntimeCredentialSource } from "../auth/runtime-credentials.js";
import { EnvCredentialSource } from "../auth/env-credentials.js";
import { defaultAuthFile, FileCredentialSource } from "../auth/file-credentials.js";

/** Returns the configured client, or the message explaining what is missing. */
export async function createConfiguredClient(
  options: CliOptions,
  registry: ProviderRegistry = defaultProviderRegistry,
  resolver: CredentialResolver = defaultCredentialResolver(options),
): Promise<LLMClient | string> {
  const definition = registry.get(options.provider);
  if (options.model === undefined) {
    const variables = definition.modelEnvKeys.join(" or ");
    return `--model or ${variables} is required for ${definition.id}.`;
  }
  if (definition.requiresBaseURL && options.baseURL === undefined) {
    const variables = definition.baseUrlEnvKeys.join(" or ");
    return `${variables} is required for ${definition.id}.`;
  }

  let credential;
  try {
    credential = await resolver.resolve(definition);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  if (credential === undefined) {
    return resolver.describeExpectations(definition);
  }

  const client = definition.createClient({
    apiKey: credential.apiKey,
    model: options.model,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  });

  return new RetryingLLMClient(client, {
    onRetry: ({ attempt, delayMs, reason }) => {
      process.stderr.write(
        `Provider call failed (${reason}); retry ${attempt} in ${delayMs}ms.\n`,
      );
    },
  });
}

function defaultCredentialResolver(options: CliOptions): CredentialResolver {
  return new CredentialResolver([
    new RuntimeCredentialSource(options.apiKey),
    new EnvCredentialSource(process.env),
    new FileCredentialSource(defaultAuthFile(process.env), (message) => {
      process.stderr.write(`${message}\n`);
    }),
  ]);
}
