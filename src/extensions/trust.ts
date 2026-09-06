import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { defaultSessionHome } from "../session-store.js";

export const CONFIG_DIRECTORY = ".chivgent";
export const EXTENSIONS_DIRECTORY = "extensions";
const TRUST_FILE = "trust.json";

export class TrustFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrustFileError";
  }
}

export function defaultTrustFile(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(defaultSessionHome(environment), TRUST_FILE);
}

/**
 * Resolves a directory the way the trust store keys it.
 *
 * Symlinks and `..` are resolved first so that two paths naming the same
 * directory cannot produce two entries, one of which the user never sees.
 */
export async function canonicalDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  try {
    return await realpath(absolute);
  } catch {
    // A directory that does not exist cannot be resolved, but it can still be
    // recorded; the lexical form is the best available key.
    return absolute;
  }
}

export type TrustDecision = boolean;

export interface TrustEntry {
  /** The directory the decision was recorded against, which may be an ancestor. */
  readonly path: string;
  readonly decision: TrustDecision;
}

/**
 * Records whether a project directory may contribute code to chivgent.
 *
 * Decisions are looked up by nearest ancestor, so trusting `~/work` covers
 * every repository under it. A monorepo does not ask once per package.
 */
export class TrustStore {
  constructor(private readonly filePath: string = defaultTrustFile()) {}

  get location(): string {
    return this.filePath;
  }

  async lookup(directory: string): Promise<TrustEntry | undefined> {
    const data = await this.read();
    let current = await canonicalDirectory(directory);
    for (;;) {
      const decision = data[current];
      if (decision !== undefined) {
        return { path: current, decision };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  async set(directory: string, decision: TrustDecision): Promise<void> {
    const key = await canonicalDirectory(directory);
    const data = await this.read();
    data[key] = decision;
    await this.write(data);
  }

  /**
   * Removes the decision that covers this directory, including an ancestor's,
   * so that forgetting actually makes chivgent ask again.
   */
  async forget(directory: string): Promise<string | undefined> {
    const entry = await this.lookup(directory);
    if (entry === undefined) {
      return undefined;
    }
    const data = await this.read();
    delete data[entry.path];
    await this.write(data);
    return entry.path;
  }

  private async read(): Promise<Record<string, boolean>> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new TrustFileError(
        `Could not read the trust file at ${this.filePath}.`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error: unknown) {
      throw new TrustFileError(
        `The trust file at ${this.filePath} is not valid JSON.`,
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TrustFileError(
        `The trust file at ${this.filePath} must contain a JSON object keyed by directory.`,
      );
    }

    const data: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "boolean") {
        throw new TrustFileError(
          `The trust file entry for "${key}" must be true or false.`,
        );
      }
      data[key] = value;
    }
    return data;
  }

  private async write(data: Record<string, boolean>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const sorted: Record<string, boolean> = {};
    for (const key of Object.keys(data).sort()) {
      sorted[key] = data[key] as boolean;
    }
    // The file is meant to be read and edited by a person, so it stays sorted
    // and indented rather than compact.
    await writeFile(
      this.filePath,
      `${JSON.stringify(sorted, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

/** True when the project directory carries anything trust has to gate. */
export function hasProjectExtensions(cwd: string): boolean {
  return existsSync(path.join(cwd, CONFIG_DIRECTORY, EXTENSIONS_DIRECTORY));
}
