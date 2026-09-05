import type { LLMClient } from "../llm.js";
import { OpenAIClient } from "./openai.js";
import { OpenAICompatibleChatClient } from "./openai-compatible-chat.js";
import { DeepSeekChatClient } from "./deepseek.js";

export interface ProviderClientConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
}

export interface ProviderDefinition {
  readonly id: string;
  /** Environment variables searched in order for this Provider's API key. */
  readonly envKeys: readonly string[];
  /** Environment variables searched in order for a default model. */
  readonly modelEnvKeys: readonly string[];
  /** Used when neither --model nor an environment variable supplies one. */
  readonly defaultModel?: string;
  /** Environment variables searched in order for a base URL override. */
  readonly baseUrlEnvKeys: readonly string[];
  readonly defaultBaseURL?: string;
  /** True when the Provider cannot be configured without an explicit model. */
  readonly requiresModel: boolean;
  /** True when the Provider cannot be configured without an explicit base URL. */
  readonly requiresBaseURL: boolean;
  createClient(config: ProviderClientConfig): LLMClient;
}

/**
 * Most Providers speak OpenAI-compatible Chat Completions and differ only by
 * base URL, so they are declared rather than implemented.
 */
function compatibleProvider(definition: {
  readonly id: string;
  readonly envKeys: readonly string[];
  readonly modelEnvKeys: readonly string[];
  readonly defaultBaseURL: string;
  readonly defaultModel?: string;
}): ProviderDefinition {
  return {
    id: definition.id,
    envKeys: definition.envKeys,
    modelEnvKeys: definition.modelEnvKeys,
    ...(definition.defaultModel === undefined
      ? {}
      : { defaultModel: definition.defaultModel }),
    baseUrlEnvKeys: [],
    defaultBaseURL: definition.defaultBaseURL,
    requiresModel: definition.defaultModel === undefined,
    requiresBaseURL: false,
    createClient: ({ apiKey, model, baseURL }) =>
      new OpenAICompatibleChatClient({
        apiKey,
        model,
        baseURL: baseURL ?? definition.defaultBaseURL,
        continuationTag: `${definition.id}-chat`,
      }),
  };
}

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "openai",
    envKeys: ["OPENAI_API_KEY"],
    modelEnvKeys: ["OPENAI_MODEL"],
    defaultModel: "gpt-5.6",
    baseUrlEnvKeys: [],
    requiresModel: false,
    requiresBaseURL: false,
    createClient: ({ apiKey, model }) => new OpenAIClient({ apiKey, model }),
  },
  {
    id: "deepseek",
    envKeys: ["DEEPSEEK_API_KEY"],
    modelEnvKeys: ["DEEPSEEK_MODEL"],
    defaultModel: "deepseek-v4-flash",
    baseUrlEnvKeys: [],
    requiresModel: false,
    requiresBaseURL: false,
    createClient: ({ apiKey, model, baseURL }) =>
      new DeepSeekChatClient({
        apiKey,
        model,
        ...(baseURL === undefined ? {} : { baseURL }),
      }),
  },
  {
    id: "openai-compatible",
    envKeys: ["OPENAI_API_KEY"],
    modelEnvKeys: ["OPENAI_MODEL"],
    baseUrlEnvKeys: ["OPENAI_BASE_URL"],
    requiresModel: true,
    requiresBaseURL: true,
    createClient: ({ apiKey, model, baseURL }) => {
      if (baseURL === undefined) {
        throw new TypeError("OpenAI-compatible Provider requires a base URL.");
      }
      return new OpenAICompatibleChatClient({
        apiKey,
        model,
        baseURL,
        continuationTag: "openai-compatible-chat",
      });
    },
  },
  compatibleProvider({
    id: "openrouter",
    envKeys: ["OPENROUTER_API_KEY"],
    modelEnvKeys: ["OPENROUTER_MODEL"],
    defaultBaseURL: "https://openrouter.ai/api/v1",
  }),
  compatibleProvider({
    id: "groq",
    envKeys: ["GROQ_API_KEY"],
    modelEnvKeys: ["GROQ_MODEL"],
    defaultBaseURL: "https://api.groq.com/openai/v1",
  }),
  compatibleProvider({
    id: "xai",
    envKeys: ["XAI_API_KEY"],
    modelEnvKeys: ["XAI_MODEL"],
    defaultBaseURL: "https://api.x.ai/v1",
  }),
  compatibleProvider({
    id: "moonshot",
    envKeys: ["MOONSHOT_API_KEY"],
    modelEnvKeys: ["MOONSHOT_MODEL"],
    defaultBaseURL: "https://api.moonshot.cn/v1",
  }),
];
