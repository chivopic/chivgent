import type OpenAI from "openai";
import {
  OpenAICompatibleChatClient,
  type OpenAICompatibleChatClientOptions,
} from "./openai-compatible-chat.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekChatClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly client?: OpenAI;
}

export class DeepSeekChatClient extends OpenAICompatibleChatClient {
  constructor(options: DeepSeekChatClientOptions) {
    const compatibleOptions: OpenAICompatibleChatClientOptions = {
      apiKey: options.apiKey,
      model: options.model,
      baseURL: options.baseURL ?? DEFAULT_BASE_URL,
      continuationTag: "deepseek-chat",
      ...(options.client === undefined ? {} : { client: options.client }),
    };
    super(compatibleOptions);
  }
}
