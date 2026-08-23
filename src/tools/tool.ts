import type { Workspace } from "../workspace.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ToolContext {
  readonly workspace: Workspace;
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
