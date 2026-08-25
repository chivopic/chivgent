import {
  emitEvent,
  type AgentEventListener,
  type AgentRunStatus,
} from "./events.js";
import { isAbortError, type LLMClient, type LLMContinuation } from "./llm.js";
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
  /** Receives runtime events synchronously, in emission order. */
  readonly onEvent?: AgentEventListener;
  /** Use the Provider's streaming API when it offers one. Defaults to true. */
  readonly streaming?: boolean;
}

export interface AgentRunOptions {
  /** Cancels the run between turns, during a Provider call, and between tools. */
  readonly signal?: AbortSignal;
  /**
   * Messages that precede this prompt. The Agent never mutates the array it is
   * given; a session owns its transcript and passes a snapshot in.
   */
  readonly history?: readonly Message[];
}

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly finalMessage: AssistantMessage;
      readonly messages: readonly Message[];
      readonly turnCount: number;
    }
  | {
      readonly status: "max_turns" | "aborted";
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
  private readonly onEvent?: AgentEventListener;
  private readonly streaming: boolean;

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
    if (options.onEvent !== undefined) {
      this.onEvent = options.onEvent;
    }
    this.streaming = options.streaming ?? true;
  }

  get toolNames(): readonly string[] {
    return [...this.registry.keys()];
  }

  async run(
    userInput: string,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    if (userInput.trim().length === 0) {
      throw new TypeError("User input must not be empty.");
    }

    const state: RunState = {
      messages: [
        ...structuredClone(options.history ?? []),
        { role: "user", content: userInput },
      ],
      seenToolCallIds: new Set<string>(),
      turnCount: 0,
    };
    const signal = options.signal;

    this.emit({
      type: "agent_start",
      prompt: userInput,
      maxTurns: this.maxTurns,
    });

    try {
      const result = await this.loop(state, signal);
      this.emitEnd(result.status, state);
      return result;
    } catch (error: unknown) {
      if (isAbortError(error) || isAborted(signal)) {
        this.emitEnd("aborted", state);
        return abortedResult(state);
      }
      this.emitEnd(
        "error",
        state,
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }

  private async loop(
    state: RunState,
    signal: AbortSignal | undefined,
  ): Promise<AgentRunResult> {
    while (state.turnCount < this.maxTurns) {
      if (isAborted(signal)) {
        return abortedResult(state);
      }

      state.turnCount += 1;
      const turn = state.turnCount;
      this.emit({ type: "turn_start", turn });
      this.emit({ type: "message_start", turn });

      const response = await this.requestAssistantMessage(state, turn, signal);
      const assistant = validateAndCloneAssistantMessage(response.message);
      this.assertUniqueToolCallIds(assistant.toolCalls, state.seenToolCallIds);
      state.messages.push(assistant);
      state.continuation = response.continuation;
      this.emit({ type: "message_end", turn, message: assistant });

      if (assistant.toolCalls.length === 0) {
        this.emit({
          type: "turn_end",
          turn,
          message: assistant,
          toolResults: [],
        });
        return {
          status: "completed",
          finalMessage: assistant,
          messages: snapshotMessages(state.messages),
          turnCount: state.turnCount,
        };
      }

      const toolResults: ToolResultMessage[] = [];
      for (const toolCall of assistant.toolCalls) {
        if (isAborted(signal)) {
          return abortedResult(state);
        }
        const result = await this.executeToolCall(toolCall, turn, signal);
        toolResults.push(result);
        state.messages.push(result);
      }
      this.emit({ type: "turn_end", turn, message: assistant, toolResults });
    }

    return {
      status: "max_turns",
      messages: snapshotMessages(state.messages),
      turnCount: state.turnCount,
    };
  }

  private async requestAssistantMessage(
    state: RunState,
    turn: number,
    signal: AbortSignal | undefined,
  ): ReturnType<LLMClient["complete"]> {
    const request = {
      systemPrompt: this.systemPrompt,
      messages: snapshotMessages(state.messages),
      tools: this.toolDefinitions,
      ...(state.continuation === undefined
        ? {}
        : { continuation: state.continuation }),
      ...(signal === undefined ? {} : { signal }),
    };

    if (this.streaming && this.llm.stream !== undefined) {
      return this.llm.stream(request, {
        onTextDelta: (delta) => {
          if (delta.length > 0) {
            this.emit({ type: "message_update", turn, delta });
          }
        },
      });
    }
    return this.llm.complete(request);
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
    turn: number,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultMessage> {
    this.emit({
      type: "tool_execution_start",
      turn,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    });

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
          await tool.execute(toolCall.arguments, {
            workspace: this.workspace,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        output = {
          content: `Tool execution failed: ${toolCall.name}`,
          isError: true,
        };
      }
    }

    this.emit({
      type: "tool_execution_end",
      turn,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: output.content,
      isError: output.isError,
    });

    return {
      role: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: output.content,
      isError: output.isError,
    };
  }

  private emit(event: Parameters<typeof emitEvent>[1]): void {
    emitEvent(this.onEvent, event);
  }

  private emitEnd(
    status: AgentRunStatus,
    state: RunState,
    error?: string,
  ): void {
    this.emit({
      type: "agent_end",
      status,
      turnCount: state.turnCount,
      messages: snapshotMessages(state.messages),
      ...(error === undefined ? {} : { error }),
    });
  }
}

/** Kept as a call so narrowing never hides a signal that aborts mid-run. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function abortedResult(state: RunState): AgentRunResult {
  return {
    status: "aborted",
    messages: snapshotMessages(state.messages),
    turnCount: state.turnCount,
  };
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
