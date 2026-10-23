import type { Workspace } from "../workspace.js";
import type { PlanUpdate } from "./update-plan.js";
import type { Question, QuestionOutcome } from "../questions.js";

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
  /**
   * Reports progress from a long-running tool. The content is a snapshot of
   * the output so far, not a delta. Ignoring it is always valid.
   */
  readonly onUpdate?: (content: string) => void;
  /** Successful control-tool plans reach the event stream, not the filesystem. */
  readonly onPlanUpdate?: (update: PlanUpdate) => void;
  /** Present only for the exact built-in question tool. */
  readonly requestQuestion?: (questions: readonly Question[]) => Promise<QuestionOutcome>;
}

export interface ToolOutput {
  readonly content: string;
  readonly isError: boolean;
  /** Typed shell output capability; deliberately not an extensible metadata bag. */
  readonly shellOutput?: { readonly id: string; readonly state: "complete" | "incomplete" | "unavailable"; readonly totalLines: number };
}

/** An intentional, user-safe failure message from a tool (including extensions). */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export interface Tool extends ToolDefinition {
  execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput>;
}
