import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultAuthFile } from "../auth/file-credentials.js";
import type { ProviderRegistry } from "./registry.js";

export function providerPreferenceFile(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(defaultAuthFile(environment)), "provider.json");
}

/** A missing preference is normal; an unreadable or invalid one is not. */
async function readPreferenceData(file: string, registry: ProviderRegistry): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read Provider preference at ${file}; use --provider to choose explicitly.`, { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error: unknown) { throw new Error(`Invalid Provider preference at ${file}; use --provider to choose explicitly.`, { cause: error }); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      typeof (parsed as { provider?: unknown }).provider !== "string") {
    throw new Error(`Invalid Provider preference at ${file}; use --provider to choose explicitly.`);
  }
  const provider = (parsed as { provider: string }).provider;
  if (!registry.has(provider) || registry.get(provider).requiresBaseURL) {
    throw new Error(`Unsupported saved Provider at ${file}; use --provider to choose explicitly.`);
  }
  return parsed as Record<string, unknown>;
}

export async function readProviderPreference(file: string, registry: ProviderRegistry): Promise<string | undefined> {
  const data = await readPreferenceData(file, registry);
  return data?.provider as string | undefined;
}

/** Preserve unknown data on read errors and replace a complete file atomically. */
export async function writeProviderPreference(file: string, provider: string, registry: ProviderRegistry): Promise<void> {
  const existing = await readPreferenceData(file, registry);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ ...existing, provider }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
