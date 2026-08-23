export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}
