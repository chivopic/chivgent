import type { Usage } from "../llm.js";

/** A failed compaction operation that may have incurred Provider usage. */
export class ContextCompactionError extends Error {
  constructor(
    message: string,
    readonly compactionUsage?: Usage,
    readonly compactionUsageComplete?: boolean,
  ) {
    super(message);
    this.name = "ContextCompactionError";
  }
}

/** A compaction failure caused by an actual context capacity limit. */
export class ContextBudgetError extends ContextCompactionError {
  constructor(
    message: string,
    compactionUsage?: Usage,
    compactionUsageComplete?: boolean,
  ) {
    super(message, compactionUsage, compactionUsageComplete);
    this.name = "ContextBudgetError";
  }
}
