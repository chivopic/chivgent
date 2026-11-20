import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultProviderRegistry } from "@chivgent/providers/registry.ts";
import type { DeepSeekCredentialCodec } from "../protocol/credentials.js";
import type { SaveProviderProfileRequest } from "../protocol/messages.js";

export interface DesktopProviderProfile {
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly apiKey: string;
  readonly encrypted?: true;
}

type StoredProfile = Omit<DesktopProviderProfile, "apiKey" | "encrypted"> & (
  | { readonly apiKey: string; readonly encryptedApiKey?: never }
  | { readonly apiKey?: never; readonly encryptedApiKey: string }
);

export interface DesktopProviderProfileSummary {
  readonly provider: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly configured: true;
}

export interface DesktopProviderConfigStatus {
  readonly profiles: readonly DesktopProviderProfileSummary[];
  readonly notice?: string;
}

export class ProviderProfileCorruptError extends Error {
  constructor() {
    super("桌面 Provider 配置文件损坏；原文件已保留，重新保存 Provider 后可创建恢复配置。");
    this.name = "ProviderProfileCorruptError";
  }
}

export class DesktopProviderConfig {
  private readonly filePath: string;
  private readonly recoveryPath: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(directory: string, private readonly codec?: DeepSeekCredentialCodec) {
    this.filePath = join(directory, "provider-profiles.json");
    this.recoveryPath = join(directory, "provider-profiles-recovered.json");
  }

  async read(): Promise<Record<string, DesktopProviderProfile>> {
    const profiles = (await this.readWithPath()).profiles;
    return Object.fromEntries(await Promise.all(Object.entries(profiles).map(async ([id, profile]) => [id, await this.resolve(profile)])));
  }

  async readProvider(provider: string): Promise<DesktopProviderProfile | undefined> {
    const profile = (await this.readWithPath()).profiles[provider];
    return profile === undefined ? undefined : this.resolve(profile);
  }

  private async resolve(profile: StoredProfile): Promise<DesktopProviderProfile> {
    if (profile.encryptedApiKey === undefined) return profile;
    if (this.codec === undefined) throw new Error("系统凭证存储不可用。");
    const { encryptedApiKey, ...metadata } = profile;
    return { ...metadata, apiKey: await this.codec.decrypt(encryptedApiKey), encrypted: true };
  }

  save(request: SaveProviderProfileRequest): Promise<DesktopProviderProfileSummary & { readonly recovered?: true }> {
    const result = this.saveQueue.then(() => this.saveOne(request));
    this.saveQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async saveOne(request: SaveProviderProfileRequest): Promise<DesktopProviderProfileSummary & { readonly recovered?: true }> {
    const definition = defaultProviderRegistry.get(request.provider);
    const model = request.model.trim();
    if (!model || model.length > 160) throw new Error("请输入有效的模型名称（最多 160 个字符）。");
    if (request.baseURL !== undefined && request.provider !== "openai-compatible") throw new Error("只有 OpenAI compatible Provider 可以配置自定义 endpoint。");

    let loaded: { profiles: Record<string, StoredProfile>; path: string; recovered: boolean };
    let repaired = false;
    try {
      loaded = await this.readWithPath();
    } catch (error: unknown) {
      if (!(error instanceof ProviderProfileCorruptError)) throw error;
      await this.preserveCorruptRecoveryFile();
      loaded = { profiles: {}, path: this.recoveryPath, recovered: true };
      repaired = true;
    }

    const prior = loaded.profiles[request.provider];
    const apiKey = request.apiKey?.trim();
    const previousCredential = prior?.encryptedApiKey !== undefined
      ? { encryptedApiKey: prior.encryptedApiKey }
      : prior === undefined ? undefined : { apiKey: prior.apiKey };
    const credential = apiKey
      ? request.provider === "deepseek" && this.codec !== undefined
        ? { encryptedApiKey: await this.codec.encrypt(apiKey) }
        : { apiKey }
      : previousCredential;
    if (credential === undefined) throw new Error("请输入 API key。损坏的 profile 无法恢复其密钥，请重新输入。");
    let baseURL: string | undefined;
    if (definition.requiresBaseURL || request.baseURL !== undefined || prior?.baseURL !== undefined) {
      baseURL = normalizeEndpoint(request.baseURL?.trim() || prior?.baseURL || "");
    }
    loaded.profiles[request.provider] = { ...credential, provider: request.provider, model, ...(baseURL === undefined ? {} : { baseURL }) };
    await this.writeAtomically(loaded.path, loaded.profiles);
    return { provider: request.provider, model, ...(baseURL === undefined ? {} : { baseURL }), configured: true, ...(repaired ? { recovered: true } : {}) };
  }

  statusSync(): DesktopProviderConfigStatus {
    try {
      const loaded = this.readSyncWithPath();
      return {
        profiles: toSummaries(loaded.profiles),
        ...(loaded.recovered ? { notice: "原 Provider 配置文件损坏，正在使用恢复配置；重新保存可继续修复。损坏文件已保留。" } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof ProviderProfileCorruptError) {
        return {
          profiles: [],
          notice: "桌面 Provider 配置文件损坏，现有 profiles 未加载。重新保存一个 Provider 可创建恢复配置；损坏文件会保留，其他 profiles 需要重新录入。",
        };
      }
      return { profiles: [], notice: "无法读取桌面 Provider 配置；检查应用配置目录权限后重试。" };
    }
  }

  private async readWithPath(): Promise<{ profiles: Record<string, StoredProfile>; path: string; recovered: boolean }> {
    try {
      return { profiles: parseProfiles(await readFile(this.filePath, "utf8")), path: this.filePath, recovered: false };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { return { profiles: parseProfiles(await readFile(this.recoveryPath, "utf8")), path: this.recoveryPath, recovered: true }; }
        catch (recoveryError: unknown) {
          if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {}, path: this.filePath, recovered: false };
          throw recoveryError;
        }
      }
      if (!(error instanceof ProviderProfileCorruptError)) throw new Error("无法读取桌面 Provider 配置文件。");
      try { return { profiles: parseProfiles(await readFile(this.recoveryPath, "utf8")), path: this.recoveryPath, recovered: true }; }
      catch (recoveryError: unknown) {
        if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT" || recoveryError instanceof ProviderProfileCorruptError) throw new ProviderProfileCorruptError();
        throw new Error("无法读取桌面 Provider 配置文件。");
      }
    }
  }

  private readSyncWithPath(): { profiles: Record<string, StoredProfile>; recovered: boolean } {
    try { return { profiles: parseProfiles(readFileSync(this.filePath, "utf8")), recovered: false }; }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { return { profiles: parseProfiles(readFileSync(this.recoveryPath, "utf8")), recovered: true }; }
        catch (recoveryError: unknown) {
          if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {}, recovered: false };
          throw recoveryError;
        }
      }
      if (!(error instanceof ProviderProfileCorruptError)) throw error;
      try { return { profiles: parseProfiles(readFileSync(this.recoveryPath, "utf8")), recovered: true }; }
      catch (recoveryError: unknown) {
        if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT" || recoveryError instanceof ProviderProfileCorruptError) throw new ProviderProfileCorruptError();
        throw recoveryError;
      }
    }
  }

  private async writeAtomically(destination: string, profiles: Record<string, StoredProfile>): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(dirname(destination), 0o700);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(profiles, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      const directory = await open(dirname(destination), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async preserveCorruptRecoveryFile(): Promise<void> {
    const backup = `${this.recoveryPath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try { await rename(this.recoveryPath, backup); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法保留损坏的 Provider 恢复文件。");
    }
  }
}

function parseProfiles(raw: string): Record<string, StoredProfile> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ProviderProfileCorruptError(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ProviderProfileCorruptError();
  const result: Record<string, StoredProfile> = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (!defaultProviderRegistry.has(provider) || typeof value !== "object" || value === null || Array.isArray(value)) throw new ProviderProfileCorruptError();
    const item = value as Record<string, unknown>;
    if (item.provider !== provider || typeof item.model !== "string" || item.model.trim().length === 0 || item.model.length > 160) throw new ProviderProfileCorruptError();
    let baseURL: string | undefined;
    if (item.baseURL !== undefined) {
      if (typeof item.baseURL !== "string" || provider !== "openai-compatible") throw new ProviderProfileCorruptError();
      try { baseURL = normalizeEndpoint(item.baseURL); }
      catch { throw new ProviderProfileCorruptError(); }
    }
    const metadata = { provider, model: item.model, ...(baseURL === undefined ? {} : { baseURL }) };
    if (provider === "deepseek" && item.apiKey === undefined && typeof item.encryptedApiKey === "string" && item.encryptedApiKey.length > 0) {
      result[provider] = { ...metadata, encryptedApiKey: item.encryptedApiKey };
    } else if (item.encryptedApiKey === undefined && typeof item.apiKey === "string" && item.apiKey.trim().length > 0) {
      result[provider] = { ...metadata, apiKey: item.apiKey };
    } else {
      throw new ProviderProfileCorruptError();
    }
  }
  return result;
}

function toSummaries(profiles: Record<string, StoredProfile>): readonly DesktopProviderProfileSummary[] {
  return Object.values(profiles).map(({ provider, model, baseURL }) => ({ provider, model, ...(baseURL === undefined ? {} : { baseURL }), configured: true }));
}

function normalizeEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch { throw new Error("兼容 endpoint 必须是有效的 http:// 或 https:// URL，且不能包含凭证、查询参数或片段。"); }
}
