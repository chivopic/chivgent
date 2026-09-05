import type { ProviderDefinition } from "../providers/definitions.js";
import type { Credential, CredentialSource } from "./credentials.js";

/** A key supplied for this run only, typically through `--api-key`. */
export class RuntimeCredentialSource implements CredentialSource {
  readonly name = "runtime";

  constructor(private readonly apiKey?: string) {}

  async read(_provider: ProviderDefinition): Promise<Credential | undefined> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return undefined;
    }
    return { apiKey: this.apiKey, origin: "--api-key" };
  }
}
