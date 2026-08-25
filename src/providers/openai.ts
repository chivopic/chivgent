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
import type { AssistantMessage, Message } from "../messages.js";

interface OpenAIContinuation {
  readonly provider: "openai-responses";
  readonly previousResponseId: string;
}

export interface OpenAIClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly client?: OpenAI;
}

export class OpenAIClient implements LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIClientOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
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
        throw new TypeError(
          `OpenAI stream failed: ${event.response.error?.message ?? "unknown error"}`,
        );
      }
    }

    if (completed === undefined) {
      throw new TypeError("OpenAI stream ended without a completed response.");
    }
    return toLLMResponse(completed);
  }

  private createParameters(
    request: LLMRequest,
  ): Omit<ResponseCreateParamsNonStreaming, "stream"> {
    const continuation = parseContinuation(request.continuation);
    return {
      model: this.model,
      instructions: request.systemPrompt,
      input:
        continuation === undefined
          ? toInitialInput(request.messages)
          : toContinuationInput(request.messages),
      tools: request.tools.map(toOpenAITool),
      parallel_tool_calls: false,
      ...(continuation === undefined
        ? {}
        : { previous_response_id: continuation.previousResponseId }),
    };
  }
}

function toLLMResponse(response: OpenAIResponse): LLMResponse {
  return {
    message: fromOpenAIResponse(response),
    continuation: {
      provider: "openai-responses",
      previousResponseId: response.id,
    } satisfies OpenAIContinuation,
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

function toInitialInput(messages: readonly Message[]): ResponseInput {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
      case "tool":
        throw new TypeError(
          "An initial OpenAI request must contain only user messages in Stage 1.",
        );
    }
  });
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
      output: message.isError ? `Tool error: ${message.content}` : message.content,
    };
  });
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
