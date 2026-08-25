import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "../llm.js";
import type { AssistantMessage, Message } from "../messages.js";

interface CompatibleAssistantMessage extends ChatCompletionMessage {
  readonly reasoning_content?: string | null;
}

interface CompatibleAssistantMessageParam
  extends ChatCompletionAssistantMessageParam {
  readonly reasoning_content?: string | null;
}

type CompatibleHistoryMessage =
  | ChatCompletionMessageParam
  | CompatibleAssistantMessageParam;

interface CompatibleContinuation {
  readonly provider: string;
  readonly systemPrompt: string;
  readonly messages: readonly CompatibleHistoryMessage[];
}

export interface OpenAICompatibleChatClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly continuationTag?: string;
  readonly client?: OpenAI;
}

/**
 * Shared adapter for Providers that implement OpenAI-compatible Chat
 * Completions. Provider-only fields stay inside the opaque continuation.
 */
export class OpenAICompatibleChatClient implements LLMClient {
  private readonly client: OpenAI;
  private readonly continuationTag: string;
  private readonly model: string;

  constructor(options: OpenAICompatibleChatClientOptions) {
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
    this.continuationTag =
      options.continuationTag ?? "openai-compatible-chat";
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const history = this.createHistory(request);
    const parameters = {
      ...this.createParameters(request, history),
      stream: false as const,
    };
    const response =
      request.signal === undefined
        ? await this.client.chat.completions.create(parameters)
        : await this.client.chat.completions.create(parameters, {
            signal: request.signal,
          });

    return this.toLLMResponse(request, history, getProviderMessage(response));
  }

  async stream(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const history = this.createHistory(request);
    const parameters = {
      ...this.createParameters(request, history),
      stream: true as const,
    };
    const chunks =
      request.signal === undefined
        ? await this.client.chat.completions.create(parameters)
        : await this.client.chat.completions.create(parameters, {
            signal: request.signal,
          });

    const accumulator = new ChatCompletionAccumulator();
    for await (const chunk of chunks as AsyncIterable<ChatCompletionChunk>) {
      const delta = accumulator.add(chunk);
      if (delta.length > 0) {
        handlers.onTextDelta(delta);
      }
    }

    return this.toLLMResponse(request, history, accumulator.toMessage());
  }

  private createHistory(request: LLMRequest): CompatibleHistoryMessage[] {
    const continuation = parseContinuation(
      request.continuation,
      this.continuationTag,
    );
    return continuation === undefined
      ? createInitialHistory(request.systemPrompt, request.messages)
      : continueHistory(continuation, request);
  }

  private createParameters(
    request: LLMRequest,
    history: readonly CompatibleHistoryMessage[],
  ): Omit<ChatCompletionCreateParamsNonStreaming, "stream"> {
    return {
      model: this.model,
      messages: [...history],
      tools: request.tools.map(toCompatibleTool),
    };
  }

  private toLLMResponse(
    request: LLMRequest,
    history: readonly CompatibleHistoryMessage[],
    providerMessage: CompatibleAssistantMessage,
  ): LLMResponse {
    return {
      message: toInternalMessage(providerMessage),
      continuation: {
        provider: this.continuationTag,
        systemPrompt: request.systemPrompt,
        messages: structuredClone([
          ...history,
          toHistoryMessage(providerMessage),
        ]),
      } satisfies CompatibleContinuation,
    };
  }
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Rebuilds one assistant message from Chat Completions chunks. Tool call
 * fragments arrive out of band and are keyed by their stream index, so the
 * final message matches what a non-streaming call would have returned.
 */
class ChatCompletionAccumulator {
  private content = "";
  private reasoningContent = "";
  private readonly toolCalls = new Map<number, PartialToolCall>();

  /** Returns the text delta contributed by this chunk. */
  add(chunk: ChatCompletionChunk): string {
    const delta = chunk.choices[0]?.delta;
    if (delta === undefined) {
      return "";
    }

    const reasoning = (delta as { reasoning_content?: string | null })
      .reasoning_content;
    if (typeof reasoning === "string") {
      this.reasoningContent += reasoning;
    }

    for (const toolCall of delta.tool_calls ?? []) {
      const partial = this.toolCalls.get(toolCall.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      this.toolCalls.set(toolCall.index, {
        id: toolCall.id ?? partial.id,
        name: toolCall.function?.name ?? partial.name,
        arguments: partial.arguments + (toolCall.function?.arguments ?? ""),
      });
    }

    const text = delta.content ?? "";
    this.content += text;
    return text;
  }

  toMessage(): CompatibleAssistantMessage {
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]): ChatCompletionMessageToolCall => {
        if (toolCall.id.length === 0 || toolCall.name.length === 0) {
          throw new TypeError(
            "OpenAI-compatible stream produced an incomplete tool call.",
          );
        }
        return {
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments },
        };
      });

    return {
      role: "assistant",
      content: this.content,
      refusal: null,
      ...(this.reasoningContent.length === 0
        ? {}
        : { reasoning_content: this.reasoningContent }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  }
}

function parseContinuation(
  value: unknown,
  expectedTag: string,
): CompatibleContinuation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    value.provider !== expectedTag ||
    !("systemPrompt" in value) ||
    typeof value.systemPrompt !== "string" ||
    !("messages" in value) ||
    !Array.isArray(value.messages)
  ) {
    throw new TypeError(
      "OpenAI-compatible client received an incompatible continuation.",
    );
  }
  return value as unknown as CompatibleContinuation;
}

function createInitialHistory(
  systemPrompt: string,
  messages: readonly Message[],
): CompatibleHistoryMessage[] {
  const history: CompatibleHistoryMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const message of messages) {
    if (message.role !== "user") {
      throw new TypeError(
        "An initial OpenAI-compatible request must contain only user messages.",
      );
    }
    history.push({ role: "user", content: message.content });
  }
  return history;
}

function continueHistory(
  continuation: CompatibleContinuation,
  request: LLMRequest,
): CompatibleHistoryMessage[] {
  if (continuation.systemPrompt !== request.systemPrompt) {
    throw new TypeError(
      "Cannot change the system prompt during an OpenAI-compatible turn.",
    );
  }

  const lastAssistantIndex = findLastAssistantIndex(request.messages);
  if (lastAssistantIndex < 0) {
    throw new TypeError(
      "Cannot continue an OpenAI-compatible turn without an assistant message.",
    );
  }

  const pendingMessages = request.messages.slice(lastAssistantIndex + 1);
  if (
    pendingMessages.length === 0 ||
    pendingMessages.some((message) => message.role !== "tool")
  ) {
    throw new TypeError(
      "OpenAI-compatible continuation requires pending tool results.",
    );
  }

  const history = structuredClone(
    continuation.messages,
  ) as CompatibleHistoryMessage[];
  for (const message of pendingMessages) {
    if (message.role !== "tool") {
      throw new TypeError(
        "OpenAI-compatible continuation only accepts tool results.",
      );
    }
    history.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.isError
        ? `Tool error: ${message.content}`
        : message.content,
    });
  }
  return history;
}

function toCompatibleTool(
  tool: LLMRequest["tools"][number],
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.inputSchema },
    },
  };
}

function getProviderMessage(
  response: ChatCompletion,
): CompatibleAssistantMessage {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw new TypeError(
      "OpenAI-compatible Provider returned a completion with no choices.",
    );
  }
  return choice.message as CompatibleAssistantMessage;
}

function toInternalMessage(
  message: CompatibleAssistantMessage,
): AssistantMessage {
  const toolCalls = (message.tool_calls ?? []).map((toolCall) => {
    if (toolCall.type !== "function") {
      throw new TypeError(
        `OpenAI-compatible Provider returned an unsupported tool type: ${toolCall.type}`,
      );
    }
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: parseArguments(toolCall.function.arguments),
    };
  });

  return {
    role: "assistant",
    content: message.content ?? "",
    toolCalls,
  };
}

function toHistoryMessage(
  message: CompatibleAssistantMessage,
): CompatibleAssistantMessageParam {
  return {
    role: "assistant",
    content: message.content,
    ...(message.reasoning_content === undefined
      ? {}
      : { reasoning_content: message.reasoning_content }),
    ...(message.tool_calls === undefined
      ? {}
      : { tool_calls: structuredClone(message.tool_calls) }),
  };
}

function findLastAssistantIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
