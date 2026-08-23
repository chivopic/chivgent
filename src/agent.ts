import type { LLMClient, LLMContinuation } from "./llm.js";
import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
} from "./messages.js";
import type { Tool, ToolDefinition, ToolOutput } from "./tools/tool.js";
import type { Workspace } from "./workspace.js";

export interface AgentOptions {
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly llm: LLMClient;
  readonly tools: readonly Tool[];
  readonly workspace: Workspace;
}

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly finalMessage: AssistantMessage;
      readonly messages: readonly Message[];
      readonly turnCount: number;
    }
  | {
      readonly status: "max_turns";
      readonly messages: readonly Message[];
      readonly turnCount: number;
    };

interface RunState {
  readonly messages: Message[];
  readonly seenToolCallIds: Set<string>;
  turnCount: number;
  continuation?: LLMContinuation;
}

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export class Agent {
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly llm: LLMClient;
  private readonly registry: ReadonlyMap<string, Tool>;
  private readonly toolDefinitions: readonly ToolDefinition[];
  private readonly workspace: Workspace;

  constructor(options: AgentOptions) {
    if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns <= 0) {
      throw new TypeError("maxTurns must be a positive safe integer.");
    }

    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns;
    this.llm = options.llm;
    this.workspace = options.workspace;
    this.registry = createToolRegistry(options.tools);
    this.toolDefinitions = [...this.registry.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
    }));
  }

  async run(userInput: string): Promise<AgentRunResult> {
    if (userInput.trim().length === 0) {
      throw new TypeError("User input must not be empty.");
    }

    const state: RunState = {
      messages: [{ role: "user", content: userInput }],
      seenToolCallIds: new Set<string>(),
      turnCount: 0,
    };

    while (state.turnCount < this.maxTurns) {
      state.turnCount += 1;

      const response = await this.llm.complete({
        systemPrompt: this.systemPrompt,
        messages: snapshotMessages(state.messages),
        tools: this.toolDefinitions,
        ...(state.continuation === undefined
          ? {}
          : { continuation: state.continuation }),
      });

      const assistant = validateAndCloneAssistantMessage(response.message);
      this.assertUniqueToolCallIds(assistant.toolCalls, state.seenToolCallIds);
      state.messages.push(assistant);
      state.continuation = response.continuation;

      if (assistant.toolCalls.length === 0) {
        return {
          status: "completed",
          finalMessage: assistant,
          messages: snapshotMessages(state.messages),
          turnCount: state.turnCount,
        };
      }

      for (const toolCall of assistant.toolCalls) {
        state.messages.push(await this.executeToolCall(toolCall));
      }
    }

    return {
      status: "max_turns",
      messages: snapshotMessages(state.messages),
      turnCount: state.turnCount,
    };
  }

  private assertUniqueToolCallIds(
    toolCalls: readonly ToolCall[],
    seenIds: Set<string>,
  ): void {
    for (const toolCall of toolCalls) {
      if (seenIds.has(toolCall.id)) {
        throw new AgentProtocolError(
          `Provider returned a duplicate tool call id: ${toolCall.id}`,
        );
      }
      seenIds.add(toolCall.id);
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
  ): Promise<ToolResultMessage> {
    const tool = this.registry.get(toolCall.name);
    let output: ToolOutput;

    if (tool === undefined) {
      output = {
        content: `Unknown tool: ${toolCall.name}`,
        isError: true,
      };
    } else {
      try {
        output = validateToolOutput(
          await tool.execute(toolCall.arguments, { workspace: this.workspace }),
        );
      } catch {
        output = {
          content: `Tool execution failed: ${toolCall.name}`,
          isError: true,
        };
      }
    }

    return {
      role: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: output.content,
      isError: output.isError,
    };
  }
}

function createToolRegistry(tools: readonly Tool[]): ReadonlyMap<string, Tool> {
  const registry = new Map<string, Tool>();
  for (const tool of tools) {
    if (tool.name.length === 0) {
      throw new TypeError("Tool names must not be empty.");
    }
    if (registry.has(tool.name)) {
      throw new TypeError(`Duplicate tool name: ${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  return registry;
}

function validateAndCloneAssistantMessage(value: unknown): AssistantMessage {
  if (typeof value !== "object" || value === null) {
    throw new AgentProtocolError("Provider returned an invalid assistant message.");
  }

  const candidate = value as Partial<AssistantMessage>;
  if (
    candidate.role !== "assistant" ||
    typeof candidate.content !== "string" ||
    !Array.isArray(candidate.toolCalls)
  ) {
    throw new AgentProtocolError("Provider returned an invalid assistant message.");
  }

  const toolCalls = candidate.toolCalls.map((toolCall) => {
    if (
      typeof toolCall !== "object" ||
      toolCall === null ||
      typeof toolCall.id !== "string" ||
      toolCall.id.length === 0 ||
      typeof toolCall.name !== "string" ||
      toolCall.name.length === 0
    ) {
      throw new AgentProtocolError("Provider returned an invalid tool call.");
    }

    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: structuredClone(toolCall.arguments),
    };
  });

  if (candidate.content.length === 0 && toolCalls.length === 0) {
    throw new AgentProtocolError(
      "Provider returned an assistant message with no text or tool calls.",
    );
  }

  return {
    role: "assistant",
    content: candidate.content,
    toolCalls,
  };
}

function validateToolOutput(value: unknown): ToolOutput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    !("isError" in value) ||
    typeof value.content !== "string" ||
    typeof value.isError !== "boolean"
  ) {
    throw new TypeError("Tool returned an invalid output.");
  }
  return { content: value.content, isError: value.isError };
}

function snapshotMessages(messages: readonly Message[]): readonly Message[] {
  return structuredClone(messages);
}
