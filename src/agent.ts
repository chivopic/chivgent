import {
  emitEvent,
  type AgentEventListener,
  type AgentRunStatus,
} from "./events.js";
import { isAbortError, type LLMClient, type LLMContinuation } from "./llm.js";
import { addUsage, type UsageTotal } from "./providers/usage.js";
import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
} from "./messages.js";
import { ToolExecutionError, type Tool, type ToolDefinition, type ToolOutput } from "./tools/tool.js";
import { isParallelReadTool, MAX_PARALLEL_READS } from "./tools/parallel.js";
import type { Workspace } from "./workspace.js";
import type {
  AppliedCompaction,
  ContextManager,
} from "./context/context-manager.js";
import type { ProjectInstructionsProvider } from "./context/project-instructions.js";

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
  /**
   * Decides what the model sees each turn. Omit to send the whole transcript.
   */
  readonly contextManager?: ContextManager;
  /** Scoped repository guidance, read separately from trusted system prompts. */
  readonly projectInstructions?: ProjectInstructionsProvider;
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
      /** What the run cost, when the Provider reported it. */
      readonly usage?: UsageTotal;
    }
  | {
      readonly status: "max_turns" | "aborted";
      readonly messages: readonly Message[];
      readonly turnCount: number;
      readonly usage?: UsageTotal;
    };

interface RunState {
  readonly messages: Message[];
  readonly seenToolCallIds: Set<string>;
  turnCount: number;
  usage?: UsageTotal;
  continuation?: LLMContinuation;
  compaction?: AppliedCompaction;
  projectInstructionsText?: string;
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
  private readonly contextManager?: ContextManager;
  private readonly projectInstructions?: ProjectInstructionsProvider;

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
    if (options.contextManager !== undefined) {
      this.contextManager = options.contextManager;
    }
    if (options.projectInstructions !== undefined) {
      this.projectInstructions = options.projectInstructions;
    }
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

    // Older logs or crashed executions can end with an assistant tool call
    // without a corresponding tool result. Repair those pairs before sending
    // any new user message to a Provider.
    const history = structuredClone([...(options.history ?? [])]);
    closePendingToolCalls(history);
    const state: RunState = {
      messages: [
        ...history,
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
      if (result.status === "aborted") {
        closePendingToolCalls(state.messages);
        this.emitEnd("aborted", state);
        return abortedResult(state);
      }
      this.emitEnd(result.status, state);
      return result;
    } catch (error: unknown) {
      // A failed/aborted tool may leave other calls in the same assistant
      // message unanswered. Every call needs a result for future replay.
      closePendingToolCalls(state.messages);
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
      state.usage = addUsage(state.usage, response.usage);
      // A Provider might ignore AbortSignal and resolve successfully anyway.
      // Do not commit that answer as a completed turn after cancellation.
      if (isAborted(signal)) {
        return abortedResult(state);
      }
      const assistant = validateAndCloneAssistantMessage(response.message);
      this.assertUniqueToolCallIds(assistant.toolCalls, state.seenToolCallIds);
      state.messages.push(assistant);
      state.continuation = response.continuation;
      this.emit({
        type: "message_end",
        turn,
        message: assistant,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      });

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
          ...(state.usage === undefined ? {} : { usage: state.usage }),
        };
      }

      const toolResults = await this.executeToolCalls(
        assistant.toolCalls, turn, signal, state,
      );
      // A read may finish after the user cancels, even when the tool itself
      // ignores AbortSignal. Never send another model request after that.
      if (isAborted(signal)) {
        return abortedResult(state);
      }
      this.emit({ type: "turn_end", turn, message: assistant, toolResults });
    }

    return {
      status: "max_turns",
      messages: snapshotMessages(state.messages),
      turnCount: state.turnCount,
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    };
  }

  /**
   * Produces the messages for one request and records any compaction.
   *
   * A Provider holding a continuation replays its own history and ignores the
   * messages sent with it, so a fresh compaction has to drop the continuation
   * to take effect at all.
   */
  private async buildContext(
    state: RunState,
    signal: AbortSignal | undefined,
    prefixMessages: readonly Message[] = [],
  ): Promise<readonly Message[]> {
    const snapshot = snapshotMessages(state.messages);
    if (this.contextManager === undefined) {
      return snapshot;
    }

    const context = await this.contextManager.build(snapshot, {
      ...(state.compaction === undefined ? {} : { previous: state.compaction }),
      ...(signal === undefined ? {} : { signal }),
      prefixMessages,
    });
    if (context.compaction === undefined) {
      delete state.compaction;
    } else {
      state.compaction = context.compaction;
    }
    if (context.compacted) {
      delete state.continuation;
    }
    // Summarising is a Provider call this run paid for. Only add when there
    // was one: passing undefined would mark the total incomplete on every
    // turn that simply did not need compacting.
    if (context.usage !== undefined) {
      state.usage = addUsage(state.usage, context.usage);
    }
    return context.messages;
  }

  private async requestAssistantMessage(
    state: RunState,
    turn: number,
    signal: AbortSignal | undefined,
  ): ReturnType<LLMClient["complete"]> {
    const projectText = await this.projectInstructions?.load(state.messages);
    if (projectText !== state.projectInstructionsText) {
      // A chained Provider holds its own prompt history; discard that chain
      // when a new scoped AGENTS.md becomes applicable or a document changes.
      delete state.continuation;
      if (projectText === undefined) delete state.projectInstructionsText;
      else state.projectInstructionsText = projectText;
    }
    const prefixMessages: readonly Message[] = projectText === undefined
      ? [] : [{ role: "user", content: projectText }];
    const messages = await this.buildContext(state, signal, prefixMessages);
    const modelMessages: readonly Message[] = [...prefixMessages, ...messages];
    const request = {
      systemPrompt: this.systemPrompt,
      messages: modelMessages,
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

  /**
   * Run contiguous built-in read groups concurrently, with an exclusive
   * barrier around every write/shell/extension/unknown call.
   *
   * Promise.allSettled is intentional: it drains every started read before
   * agent_end, so no background events arrive after the session is persisted.
   * Results are committed in the model's call order, not completion order.
   */
  private async executeToolCalls(
    calls: readonly ToolCall[],
    turn: number,
    signal: AbortSignal | undefined,
    state: RunState,
  ): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = [];
    let next = 0;

    while (next < calls.length) {
      if (isAborted(signal)) break;
      const call = calls[next];
      if (call === undefined) break;

      if (!isParallelReadTool(this.registry.get(call.name))) {
        const result = await this.executeToolCall(call, turn, signal, state);
        state.messages.push(result);
        results.push(result);
        next += 1;
        continue;
      }

      // Stop at the next exclusive call; a write must never overlap a read
      // and can never be overtaken by a later read.
      const batch: ToolCall[] = [];
      while (next < calls.length && batch.length < MAX_PARALLEL_READS) {
        const candidate = calls[next];
        if (candidate === undefined ||
          !isParallelReadTool(this.registry.get(candidate.name))) break;
        batch.push(candidate);
        next += 1;
      }

      const settled = await Promise.allSettled(
        batch.map((toolCall) => this.executeToolCall(toolCall, turn, signal, state)),
      );
      let firstFailure: unknown;
      let hasFailure = false;
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          results.push(outcome.value);
          state.messages.push(outcome.value);
        } else if (!hasFailure) {
          firstFailure = outcome.reason;
          hasFailure = true;
        }
      }
      if (hasFailure) {
        // The caller closes unmatched calls before persisting agent_end.
        // Successfully completed reads are preserved in their original order.
        throw firstFailure;
      }
    }
    return results;
  }

  private async executeToolCall(
    toolCall: ToolCall,
    turn: number,
    signal: AbortSignal | undefined,
    state: RunState,
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
        // A model may issue its very first write into a nested folder whose
        // AGENTS.md wasn't visible at sampling time. Defer the mutation until
        // the next LLM request has included those scoped instructions.
        const unseenGuidance = this.projectInstructions !== undefined &&
          ["write_file", "edit_file", "apply_patch"].includes(toolCall.name) &&
          (await this.projectInstructions.load(state.messages)) !== state.projectInstructionsText;
        if (unseenGuidance) {
          output = {
            content: "New scoped AGENTS.md instructions were discovered. No files were changed. Review the new project guidance in the next turn before retrying.",
            isError: true,
          };
        } else {
          output = validateToolOutput(
            await tool.execute(toolCall.arguments, {
              workspace: this.workspace,
              ...(signal === undefined ? {} : { signal }),
              onPlanUpdate: (update) => {
                this.emit({ type: "plan_update", turn, ...update });
              },
              onUpdate: (content: string) => {
                this.emit({
                  type: "tool_execution_update",
                  turn,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  content,
                });
              },
            }),
          );
        }
      } catch (error: unknown) {
        if (isAbortError(error) || isAborted(signal)) {
          this.emit({
            type: "tool_execution_end",
            turn,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: INTERRUPTED_TOOL_RESULT,
            isError: true,
          });
          throw error;
        }
        output = {
          // Only explicitly public messages reach the model. Unexpected errors
          // may contain file paths, tokens, or other implementation details.
          content: error instanceof ToolExecutionError
            ? error.message
            : `Tool execution failed: ${toolCall.name}`,
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
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      ...(error === undefined ? {} : { error }),
    });
  }
}

const INTERRUPTED_TOOL_RESULT = "Tool execution interrupted before completion.";

/**
 * Ensure every function call has a corresponding output before history is
 * replayed. The synthetic failure is deliberately explicit: we did not run
 * the unfinished tool, and must never imply that its side effects happened.
 *
 * Also handles historical logs with an interrupted assistant call followed by
 * a user message, inserting the missing output *before* that user message.
 */
function closePendingToolCalls(messages: Message[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (current?.role !== "assistant" || current.toolCalls.length === 0) {
      continue;
    }

    let afterTools = index + 1;
    const completed = new Map<string, ToolResultMessage>();
    while (messages[afterTools]?.role === "tool") {
      const message = messages[afterTools];
      if (message?.role === "tool") {
        completed.set(message.toolCallId, message);
      }
      afterTools += 1;
    }

    // The order of settled parallel reads is not necessarily the order in
    // which the model requested them. Rebuild in call order, including
    // explicit failure placeholders for tools that never finished.
    const normalized: ToolResultMessage[] = current.toolCalls.map(
      (call) => completed.get(call.id) ?? {
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: INTERRUPTED_TOOL_RESULT,
        isError: true,
      },
    );
    messages.splice(index + 1, afterTools - (index + 1), ...normalized);
    index += normalized.length;
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
    ...(state.usage === undefined ? {} : { usage: state.usage }),
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
