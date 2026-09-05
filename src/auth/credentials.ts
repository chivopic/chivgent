import type { ProviderDefinition } from "../providers/definitions.js";

export interface Credential {
  readonly apiKey: string;
  /** Where the key came from, used in diagnostics. Never contains the key. */
  readonly origin: string;
}

export interface CredentialSource {
  readonly name: string;
  read(provider: ProviderDefinition): Promise<Credential | undefined>;
}

/**
 * Walks credential sources in order and returns the first hit.
 *
 * The order is deliberate: an explicit `--api-key` beats the environment,
 * and the environment beats the stored file. That matches the convention
 * users already know from other CLIs, and means a stored credential can be
 * overridden for a single run without editing the file.
 */
export class CredentialResolver {
  constructor(private readonly sources: readonly CredentialSource[]) {}

  async resolve(
    provider: ProviderDefinition,
  ): Promise<Credential | undefined> {
    for (const source of this.sources) {
      const credential = await source.read(provider);
      if (credential !== undefined && credential.apiKey.length > 0) {
        return credential;
      }
    }
    return undefined;
  }

  /** Explains what the user could set, for the "no credential" error. */
  describeExpectations(provider: ProviderDefinition): string {
    const variables = provider.envKeys.join(" or ");
    return `No API key for ${provider.id}. Set ${variables}, pass --api-key, or add "${provider.id}" to the auth file.`;
  }
}
