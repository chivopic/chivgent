import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderDefinition } from "../providers/definitions.js";
import type { Credential, CredentialSource } from "./credentials.js";

export class AuthFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthFileError";
  }
}

export function defaultAuthFile(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CHIVGENT_HOME;
  const home =
    configured !== undefined && configured.length > 0
      ? configured
      : path.join(os.homedir(), ".chivgent");
  return path.join(home, "auth.json");
}

/**
 * Reads API keys from `<chivgent home>/auth.json`.
 *
 * The file deliberately supports only literal keys. Neither `$VAR` expansion
 * nor `!command` substitution is accepted: letting a config file spawn a
 * process is a large attack surface for a small convenience.
 */
export class FileCredentialSource implements CredentialSource {
  readonly name = "auth file";

  constructor(
    private readonly filePath: string = defaultAuthFile(),
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  async read(provider: ProviderDefinition): Promise<Credential | undefined> {
    let contents: string;
    try {
      await this.warnOnLoosePermissions();
      contents = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new AuthFileError(
        `Could not read the auth file at ${this.filePath}.`,
        { cause: error },
      );
    }

    const entry = this.parse(contents)[provider.id];
    if (entry === undefined) {
      return undefined;
    }
    return { apiKey: entry, origin: this.filePath };
  }

  private parse(contents: string): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error: unknown) {
      throw new AuthFileError(
        `The auth file at ${this.filePath} is not valid JSON.`,
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AuthFileError(
        `The auth file at ${this.filePath} must contain a JSON object keyed by Provider id.`,
      );
    }

    const keys: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      const apiKey = readApiKey(value);
      if (apiKey === undefined) {
        throw new AuthFileError(
          `The auth file entry for "${providerId}" must be a string or {"type":"api_key","key":"..."}.`,
        );
      }
      keys[providerId] = apiKey;
    }
    return keys;
  }

  private async warnOnLoosePermissions(): Promise<void> {
    if (process.platform === "win32") {
      return;
    }
    const stats = await stat(this.filePath);
    if ((stats.mode & 0o077) !== 0) {
      this.onWarning(
        `The auth file at ${this.filePath} is readable by other users; run chmod 600 on it.`,
      );
    }
  }
}

/**
 * Stores one Provider's key in the auth file, keeping the others.
 *
 * The file is rewritten whole because it is small and hand-editable; merging
 * first means `/login` for one Provider never discards another's key. It is
 * written owner-only, like the session log and the trust store.
 */
export async function writeApiKey(
  providerId: string,
  apiKey: string,
  filePath: string = defaultAuthFile(),
): Promise<void> {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new TypeError("providerId must be a non-empty string.");
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new TypeError("The API key must not be empty.");
  }

  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AuthFileError(
        `The auth file at ${filePath} must contain a JSON object keyed by Provider id; refusing to overwrite it.`,
      );
    }
    existing = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof AuthFileError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // An unreadable or malformed file is not overwritten: whatever is in
      // there may be the only copy of another Provider's key.
      throw new AuthFileError(
        `Could not read the existing auth file at ${filePath}; fix or remove it first.`,
        { cause: error },
      );
    }
  }

  existing[providerId] = apiKey.trim();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readApiKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== undefined && record.type !== "api_key") {
    return undefined;
  }
  return typeof record.key === "string" ? record.key : undefined;
}
