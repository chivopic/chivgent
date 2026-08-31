import type { Workspace } from "../workspace.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolContext {
  readonly workspace: Workspace;
  /**
   * Cancels long-running tool work. Read-only tools may ignore it; tools that
   * spawn processes or walk large trees should honour it.
   */
  readonly signal?: AbortSignal;
}

export interface ToolOutput {
  readonly content: string;
  readonly isError: boolean;
}

export interface Tool extends ToolDefinition {
  execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput>;
}
