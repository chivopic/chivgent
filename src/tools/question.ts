import { validateQuestions } from "../questions.js";
import { QuestionBroker, type Question, type QuestionOutcome } from "../questions.js";
import type { Tool, ToolContext, ToolOutput } from "./tool.js";

const inputSchema = {
  type: "object", properties: { questions: {
    type: "array", minItems: 1, maxItems: 5,
    items: { type: "object", properties: {
      id: { type: "string", minLength: 1, maxLength: 48 },
      header: { type: "string", minLength: 1, maxLength: 80 },
      question: { type: "string", minLength: 1, maxLength: 2000 },
      options: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: {
        label: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", minLength: 1, maxLength: 2000 },
      }, required: ["label"], additionalProperties: false } },
      multiple: { type: "boolean" }, allowFreeText: { type: "boolean" },
    }, required: ["id", "header", "question"], additionalProperties: false },
  } }, required: ["questions"], additionalProperties: false,
} as const;

export class QuestionTool implements Tool {
  readonly name = "question";
  readonly description = "Ask the user a structured question about requirements. The answer collects input only; it never approves writes, shell commands, or a permission change.";
  readonly inputSchema = inputSchema;

  constructor(readonly broker: QuestionBroker) {}

  async execute(value: unknown, context: ToolContext): Promise<ToolOutput> {
    let questions: readonly Question[];
    try { questions = validateQuestions(value); }
    catch (error: unknown) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    if (context.signal?.aborted) return { content: "Question cancelled because the run was aborted.", isError: true };
    if (context.requestQuestion === undefined) return { content: "Question unavailable: no interactive question channel is attached.", isError: true };
    const outcome = await context.requestQuestion(questions);
    return renderOutcome(outcome);
  }
}

function renderOutcome(outcome: QuestionOutcome): ToolOutput {
  if (outcome.status === "answered") return { content: JSON.stringify({ answers: outcome.answers }), isError: false };
  if (outcome.status === "cancelled") return {
    content: outcome.reason === "aborted" ? "Question cancelled because the run was aborted." : "Question cancelled by the user.",
    isError: true,
  };
  return { content: `Question unavailable: ${outcome.reason}.`, isError: true };
}
