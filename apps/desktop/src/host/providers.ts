import { DEEPSEEK_BASE_URL } from "@chivgent/providers/deepseek.ts";
import { defaultProviderRegistry } from "@chivgent/providers/registry.ts";
import { DesktopProviderNotConfigured, resolveDesktopProvider } from "@chivgent/runtime/desktop-runtime.ts";
import type { IpcFailure } from "../protocol/messages.js";
import type { DesktopProviderConfig } from "./provider-config.js";

export async function readProviderAvailability(config: DesktopProviderConfig, environment: NodeJS.ProcessEnv, defaultProvider: string) {
  const providers = await Promise.all(defaultProviderRegistry.ids().map(async (provider) => {
    try {
      const profile = await config.readProvider(provider);
      await resolveDesktopProvider({
        provider, environment, model: profile?.model, baseURL: profile?.baseURL,
        desktopApiKey: profile?.apiKey, importedDeepSeekKey: profile?.encrypted ? profile.apiKey : undefined,
      });
      return { provider, imported: profile?.encrypted === true };
    } catch (error) {
      return { unreadable: !(error instanceof DesktopProviderNotConfigured) };
    }
  }));
  const readyProviders = providers.flatMap(({ provider }) => provider === undefined ? [] : [provider]);
  const preferred = environment.CHIVGENT_PROVIDER ?? providers.find(({ imported }) => imported)?.provider ?? defaultProvider;
  return {
    readyProviders,
    defaultProvider: readyProviders.includes(preferred) ? preferred : readyProviders[0] ?? defaultProvider,
    warning: providers.some(({ unreadable }) => unreadable),
  };
}

export async function validateDeepSeekKey(apiKey: string, fetchModels: typeof fetch = fetch): Promise<IpcFailure | undefined> {
  try {
    const response = await fetchModels(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return failure("invalid_key", "DeepSeek 拒绝了此 API Key。请检查密钥后重试。");
      if (response.status === 402) return failure("insufficient_balance", "DeepSeek API 余额不足，请充值后重试。");
      if (response.status === 429) return failure("rate_limited", "DeepSeek 请求过于频繁，请稍后重试。");
      return failure("provider_unavailable", `DeepSeek 暂时无法验证密钥（HTTP ${response.status}）。`);
    }
    const listing: unknown = await response.json();
    if (typeof listing !== "object" || listing === null || !("data" in listing) || !Array.isArray(listing.data)) {
      return failure("provider_unavailable", "DeepSeek 未返回有效的模型列表，请稍后重试。");
    }
  } catch {
    return failure("provider_unavailable", "无法完成 DeepSeek 密钥验证，请检查网络后重试。");
  }
}

function failure(code: string, message: string): IpcFailure {
  return { ok: false, code, message };
}
