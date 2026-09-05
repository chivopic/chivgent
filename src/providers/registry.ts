import { BUILTIN_PROVIDERS, type ProviderDefinition } from "./definitions.js";

/**
 * Holds the known Providers so that adding one is a definition rather than a
 * new branch in the CLI.
 */
export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(definitions: readonly ProviderDefinition[] = BUILTIN_PROVIDERS) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ProviderDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new TypeError(`Duplicate Provider id: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  get(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (definition === undefined) {
      throw new TypeError(
        `Unsupported provider: ${id}. Expected one of ${this.ids().join(", ")}.`,
      );
    }
    return definition;
  }

  ids(): readonly string[] {
    return [...this.definitions.keys()];
  }
}

export const defaultProviderRegistry = new ProviderRegistry();
