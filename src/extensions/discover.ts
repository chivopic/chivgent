import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIRECTORY, EXTENSIONS_DIRECTORY } from "./trust.js";
import { defaultSessionHome } from "../session-store.js";

export type ExtensionOrigin = "user" | "project";

export interface DiscoveredExtension {
  readonly path: string;
  readonly origin: ExtensionOrigin;
}

export function userExtensionsDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(defaultSessionHome(environment), EXTENSIONS_DIRECTORY);
}

export function projectExtensionsDirectory(cwd: string): string {
  return path.join(cwd, CONFIG_DIRECTORY, EXTENSIONS_DIRECTORY);
}

/**
 * Lists the extension entry points in one directory.
 *
 * Two shapes are recognised: `name.js`, and `name/index.js`. Nesting stops
 * there. Anything more elaborate is a package, and packaging is not what this
 * stage is about.
 */
async function discoverIn(
  directory: string,
  origin: ExtensionOrigin,
): Promise<DiscoveredExtension[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: DiscoveredExtension[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push({ path: entryPath, origin });
      continue;
    }
    if (entry.isDirectory()) {
      const index = path.join(entryPath, "index.js");
      try {
        if ((await stat(index)).isFile()) {
          found.push({ path: index, origin });
        }
      } catch {
        // A directory without an index is not an extension.
      }
    }
  }
  return found;
}

export interface DiscoverOptions {
  readonly cwd: string;
  /** Project extensions are only discovered once trust has been granted. */
  readonly includeProject: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * User extensions come first so that a project cannot take a name the user
 * already uses: the first registration of a name wins.
 */
export async function discoverExtensions(
  options: DiscoverOptions,
): Promise<readonly DiscoveredExtension[]> {
  const environment = options.environment ?? process.env;
  const found = [
    ...(await discoverIn(userExtensionsDirectory(environment), "user")),
  ];
  if (options.includeProject) {
    found.push(
      ...(await discoverIn(projectExtensionsDirectory(options.cwd), "project")),
    );
  }
  return found;
}
