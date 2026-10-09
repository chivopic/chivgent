import type { Tool, ToolContext, ToolOutput } from "./tool.js";

/** A bounded, structured task checklist. It never grants permission to act. */
export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface PlanUpdate {
  readonly plan: readonly PlanStep[];
  readonly explanation?: string;
}

const MAX_STEPS = 8;
const MAX_STEP_LENGTH = 160;
const MAX_EXPLANATION_LENGTH = 400;

/** Parsed snapshots are immutable to callers, loggers and event listeners. */
export function parsePlanUpdate(value: unknown): PlanUpdate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "plan" && key !== "explanation")) return undefined;
  const plan = record.plan;
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_STEPS) return undefined;
  const explanation = record.explanation;
  if (explanation !== undefined &&
    (typeof explanation !== "string" || explanation.length > MAX_EXPLANATION_LENGTH ||
      /[\x00-\x1f\x7f]/.test(explanation))) return undefined;
  const steps: PlanStep[] = [];
  const unique = new Set<string>();
  let active = 0;
  for (const value of plan) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => key !== "step" && key !== "status")) return undefined;
    if (typeof row.step !== "string" || row.step.trim().length === 0 ||
      row.step.length > MAX_STEP_LENGTH || /[\x00-\x1f\x7f]/.test(row.step)) return undefined;
    if (row.status !== "pending" && row.status !== "in_progress" && row.status !== "completed") return undefined;
    const step = row.step.trim();
    const key = step.toLocaleLowerCase("en");
    if (unique.has(key)) return undefined;
    unique.add(key);
    if (row.status === "in_progress") active += 1;
    if (active > 1) return undefined;
    steps.push({ step, status: row.status });
  }
  return {
    plan: steps,
    ...(explanation === undefined ? {} : { explanation: explanation as string }),
  };
}

const inputSchema = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      maxLength: MAX_EXPLANATION_LENGTH,
      description: "Optional brief reason for changing the plan.",
    },
    plan: {
      type: "array", minItems: 1, maxItems: MAX_STEPS,
      items: {
        type: "object",
        properties: {
          step: { type: "string", minLength: 1, maxLength: MAX_STEP_LENGTH },
          status: {
            type: "string", enum: ["pending", "in_progress", "completed"],
          },
        },
        required: ["step", "status"],
        additionalProperties: false,
      },
      description: "Complete current checklist; at most one step in_progress.",
    },
  },
  required: ["plan"],
  additionalProperties: false,
} as const;

/**
 * Similar to Codex's update_plan checklist tool, NOT Codex's separate Plan Mode.
 * The whole plan is replaced only after strict validation succeeds.
 */
export class UpdatePlanTool implements Tool {
  readonly name = "update_plan";
  readonly description = "Publish or update a concise checklist for a multi-step task. Supply all steps and their statuses. Only one may be in_progress. Do not use for trivial tasks; this tool cannot change files or grant permissions.";
  readonly inputSchema = inputSchema;

  async execute(value: unknown, context: ToolContext): Promise<ToolOutput> {
    if (context.signal?.aborted) return { content: "Plan update cancelled.", isError: true };
    const update = parsePlanUpdate(value);
    if (update === undefined) {
      return {
        content: "Invalid plan. Supply 1–8 unique nonempty steps (max 160 characters each), allowed statuses pending/in_progress/completed, and at most one in_progress. No extra fields or control characters.",
        isError: true,
      };
    }
    context.onPlanUpdate?.(structuredClone(update));
    const completed = update.plan.filter(step => step.status === "completed").length;
    return { content: `Plan updated: ${completed}/${update.plan.length} steps completed.`, isError: false };
  }
}
