import { pathToFileURL } from "node:url";
import type { DiscoveredExtension } from "./discover.js";
import { ExtensionRegistry, type RegistryOptions } from "./registry.js";
import type { ExtensionFactory } from "./api.js";

export interface LoadedExtension {
  readonly path: string;
  readonly origin: DiscoveredExtension["origin"];
}

export interface LoadResult {
  readonly registry: ExtensionRegistry;
  readonly loaded: readonly LoadedExtension[];
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

export interface LoadOptions extends RegistryOptions {
  /** Injectable so tests do not have to write modules to disk to test loading. */
  readonly importModule?: (path: string) => Promise<unknown>;
}

async function defaultImport(modulePath: string): Promise<unknown> {
  // A file URL is required on Windows and harmless elsewhere.
  return import(pathToFileURL(modulePath).href);
}

function readFactory(module: unknown): ExtensionFactory | undefined {
  if (typeof module !== "object" || module === null) {
    return undefined;
  }
  const candidate = (module as { default?: unknown }).default;
  return typeof candidate === "function"
    ? (candidate as ExtensionFactory)
    : undefined;
}

/**
 * Imports each extension and lets it register.
 *
 * Importing a module runs its top-level code, so this is the point of no
 * return: everything the caller wanted to gate must already have been decided.
 * From here on the job is containment — one broken extension must leave
 * chivgent working.
 */
export async function loadExtensions(
  discovered: readonly DiscoveredExtension[],
  options: LoadOptions,
): Promise<LoadResult> {
  const registry = new ExtensionRegistry(options);
  const importModule = options.importModule ?? defaultImport;
  const loaded: LoadedExtension[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const extension of discovered) {
    let factory: ExtensionFactory | undefined;
    try {
      factory = readFactory(await importModule(extension.path));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ path: extension.path, reason });
      options.onWarning(`${extension.path}: failed to load (${reason}).`);
      continue;
    }

    if (factory === undefined) {
      const reason = "no default export function";
      failed.push({ path: extension.path, reason });
      options.onWarning(
        `${extension.path}: ${reason}; an extension must export default a function.`,
      );
      continue;
    }

    try {
      await factory(registry.apiFor(extension.path));
      loaded.push({ path: extension.path, origin: extension.origin });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ path: extension.path, reason });
      // Whatever it registered before throwing stays: partial is better than
      // discarding work that is already valid.
      options.onWarning(`${extension.path}: threw while registering (${reason}).`);
    }
  }

  return { registry, loaded, failed };
}
