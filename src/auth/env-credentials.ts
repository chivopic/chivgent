import type { ProviderDefinition } from "../providers/definitions.js";
import type { Credential, CredentialSource } from "./credentials.js";

/** Reads the Provider's declared environment variables, in declared order. */
export class EnvCredentialSource implements CredentialSource {
  readonly name = "environment";

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async read(provider: ProviderDefinition): Promise<Credential | undefined> {
    for (const key of provider.envKeys) {
      const value = this.environment[key];
      if (value !== undefined && value.length > 0) {
        return { apiKey: value, origin: key };
      }
    }
    return undefined;
  }
}
