import OpenAI from "openai";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "../llm.js";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "../messages.js";
import { fromResponsesUsage } from "./usage.js";
import { oauthApiFetch } from "../auth/oauth.js";

interface OpenAIContinuation {
  readonly provider: "openai-responses";
  readonly previousResponseId: string;
}

interface OAuthStatelessContinuation {
  readonly provider: "openai-oauth-stateless";
  /** Message boundary for identifying only newly returned tool outputs. */
  readonly messageCount: number;
  /** Accumulated input sent before the response, since response storage is off. */
  readonly priorInput: ResponseInput;
  /** Keep the complete output, including encrypted reasoning items, for stateless tool continuation. */
  readonly responseOutput: OpenAIResponse["output"];
}

export interface OpenAIClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly client?: OpenAI;
  /** ChatGPT plan tokens require streamed, non-stored Responses requests. */
  readonly oauth?: boolean;
}

export class OpenAIClient implements LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly oauth: boolean;

  constructor(options: OpenAIClientOptions) {
    const oauth = options.oauth ?? false;
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey,
      ...(oauth ? { baseURL: "https://api.openai.com/v1", fetch: oauthApiFetch("https://api.openai.com") } : {}) });
    this.model = options.model;
    this.oauth = oauth;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (this.oauth) return this.stream(request, { onTextDelta: () => undefined });
    const parameters = { ...this.createParameters(request), stream: false as const };
    const response =
      request.signal === undefined
        ? await this.client.responses.create(parameters)
        : await this.client.responses.create(parameters, {
            signal: request.signal,
          });

    return toLLMResponse(response);
  }

  async stream(
    request: LLMRequest,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    const parameters = { ...this.createParameters(request), stream: true as const };
    const events =
      request.signal === undefined
        ? await this.client.responses.create(parameters)
        : await this.client.responses.create(parameters, {
            signal: request.signal,
          });

    let completed: OpenAIResponse | undefined;
    for await (const event of events as AsyncIterable<ResponseStreamEvent>) {
      if (event.type === "response.output_text.delta") {
        handlers.onTextDelta(event.delta);
      } else if (event.type === "response.completed") {
        completed = event.response;
      } else if (event.type === "response.failed") {
        throw new TypeError(this.oauth
          ? "OpenAI subscription request failed."
          : `OpenAI stream failed: ${event.response.error?.code ?? "unknown error"}`);
      }
    }

    if (completed === undefined) {
      throw new TypeError("OpenAI stream ended without a completed response.");
    }
    return this.oauth
      ? toOAuthLLMResponse(completed, request.messages.length, (parameters.input ?? []) as ResponseInput)
      : toLLMResponse(completed);
  }

  private createParameters(
    request: LLMRequest,
  ): Omit<ResponseCreateParamsNonStreaming, "stream"> {
    const continuation = this.oauth ? undefined : parseContinuation(request.continuation);
    return {
      model: this.model,
      ...(this.oauth ? { store: false } : {}),
      ...(this.oauth ? { include: ["reasoning.encrypted_content"] } : {}),
      instructions: request.systemPrompt,
      input:
        this.oauth
          ? toOAuthStatelessInput(request.messages, parseOAuthContinuation(request.continuation))
          : continuation === undefined
            ? toInitialInput(request.messages)
            : toContinuationInput(request.messages),
      tools: request.tools.map(toOpenAITool),
      parallel_tool_calls: false,
      ...(!this.oauth && continuation !== undefined
        ? { previous_response_id: continuation.previousResponseId }
        : {}),
    };
  }
}

function toLLMResponse(response: OpenAIResponse): LLMResponse {
  const usage = fromResponsesUsage((response as { usage?: unknown }).usage);
  return {
    message: fromOpenAIResponse(response),
    ...(typeof response.model === "string" && response.model.length > 0 ? { reportedModel: response.model } : {}),
    ...(usage === undefined ? {} : { usage }),
    continuation: {
      provider: "openai-responses",
      previousResponseId: response.id,
    } satisfies OpenAIContinuation,
  };
}

function toOAuthLLMResponse(response: OpenAIResponse, messageCount: number, priorInput: ResponseInput): LLMResponse {
  const usage = fromResponsesUsage((response as { usage?: unknown }).usage);
  return {
    message: fromOpenAIResponse(response),
    ...(typeof response.model === "string" && response.model.length > 0 ? { reportedModel: response.model } : {}),
    ...(usage === undefined ? {} : { usage }),
    continuation: {
      provider: "openai-oauth-stateless",
      messageCount,
      priorInput,
      responseOutput: response.output,
    } satisfies OAuthStatelessContinuation,
  };
}

function parseContinuation(value: unknown): OpenAIContinuation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    value.provider !== "openai-responses" ||
    !("previousResponseId" in value) ||
    typeof value.previousResponseId !== "string"
  ) {
    throw new TypeError("OpenAIClient received an incompatible continuation.");
  }
  return value as OpenAIContinuation;
}

function parseOAuthContinuation(value: unknown): OAuthStatelessContinuation | undefined {
  if (value === undefined) return undefined;
  // A continuation from the API-key Responses flow is intentionally ignored:
  // OAuth must never use previous_response_id and can replay the transcript.
  if (typeof value !== "object" || value === null ||
      !("provider" in value) || value.provider !== "openai-oauth-stateless") return undefined;
  if (
      !("messageCount" in value) || !Number.isSafeInteger(value.messageCount) ||
      (value.messageCount as number) < 0 ||
      !("priorInput" in value) || !Array.isArray(value.priorInput) ||
      !("responseOutput" in value) || !Array.isArray(value.responseOutput)) {
    throw new TypeError("OpenAI OAuth received an incompatible continuation.");
  }
  return value as OAuthStatelessContinuation;
}

function toOAuthStatelessInput(
  messages: readonly Message[],
  continuation: OAuthStatelessContinuation | undefined,
): ResponseInput {
  if (continuation === undefined) return toInitialInput(messages);
  if (continuation.messageCount > messages.length) {
    throw new TypeError("OpenAI OAuth continuation does not match the transcript.");
  }
  // With store:false, replay accumulated input, the prior response output
  // (including reasoning), and only newly-added tool results. Prior assistant
  // calls are already in responseOutput, so transcript assistant messages are
  // omitted to avoid duplicating them.
  const newMessages = messages.slice(continuation.messageCount).filter((message) => message.role !== "assistant");
  const toolResults = newMessages.filter((message) => message.role === "tool");
  return [
    ...continuation.priorInput,
    ...continuation.responseOutput as unknown as ResponseInput,
    ...toInitialInput(toolResults),
  ];
}

/**
 * Replays a whole transcript as Responses input. A session's second prompt
 * starts a new request with earlier assistant turns and tool results already in
 * it, so the initial input cannot be limited to user messages.
 */
function toInitialInput(messages: readonly Message[]): ResponseInput {
  const input: ResponseInput = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
        input.push({ role: "user", content: message.content });
        break;

      case "assistant":
        if (message.content.length > 0) {
          input.push({ role: "assistant", content: message.content });
        }
        for (const toolCall of message.toolCalls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: stringifyArguments(toolCall.arguments),
          });
        }
        break;

      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: toolOutput(message),
        });
        break;
    }
  }

  return input;
}

function stringifyArguments(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function toContinuationInput(messages: readonly Message[]): ResponseInput {
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) {
    throw new TypeError("Cannot continue without an assistant message.");
  }

  const pendingMessages = messages.slice(lastAssistantIndex + 1);
  if (
    pendingMessages.length === 0 ||
    pendingMessages.some((message) => message.role !== "tool")
  ) {
    throw new TypeError("OpenAI continuation requires pending tool results.");
  }

  return pendingMessages.map((message) => {
    if (message.role !== "tool") {
      throw new TypeError("OpenAI continuation only accepts tool results.");
    }
    return {
      type: "function_call_output" as const,
      call_id: message.toolCallId,
      output: toolOutput(message),
    };
  });
}

function toolOutput(message: ToolResultMessage): string {
  return message.isError ? `Tool error: ${message.content}` : message.content;
}

function toOpenAITool(tool: LLMRequest["tools"][number]): OpenAITool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.inputSchema },
    strict: true,
  };
}

function fromOpenAIResponse(response: OpenAIResponse): AssistantMessage {
  const toolCalls = response.output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.call_id,
      name: item.name,
      arguments: parseArguments(item.arguments),
    }));

  return {
    role: "assistant",
    content: response.output_text,
    toolCalls,
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
