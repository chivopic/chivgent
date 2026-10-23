import { randomUUID } from "node:crypto";

export const MAX_QUESTIONS = 5;
export const MAX_QUESTION_TEXT = 2_000;
export const MAX_QUESTION_HEADER = 80;
export const MAX_QUESTION_OPTIONS = 8;
export const MAX_QUESTION_OPTION_LABEL = 120;
export const MAX_QUESTION_ANSWER = 2_000;

export interface QuestionOption { readonly label: string; readonly description?: string; }
export interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options?: readonly QuestionOption[];
  readonly multiple?: boolean;
  readonly allowFreeText?: boolean;
}
export interface QuestionAnswer { readonly questionId: string; readonly value: string | readonly string[]; }
export interface QuestionBinding { readonly runId: string; readonly toolCallId: string; }
export interface QuestionPrompt extends QuestionBinding { readonly requestId: string; readonly questions: readonly Question[]; }
export interface QuestionReply extends QuestionBinding { readonly requestId: string; readonly answers: readonly QuestionAnswer[]; }
export type QuestionOutcome =
  | { readonly status: "answered"; readonly answers: readonly QuestionAnswer[] }
  | { readonly status: "cancelled"; readonly reason: "user" | "aborted" }
  | { readonly status: "unavailable"; readonly reason: string };
export type QuestionPresenter = (
  prompt: QuestionPrompt,
  signal?: AbortSignal,
) => Promise<QuestionReply | { readonly status: "cancelled" } | { readonly status: "unavailable"; readonly reason: string }>;

/** One bounded request per run, paired to its exact tool call. */
export class QuestionBroker {
  private activeRequestId: string | undefined;

  async ask(binding: QuestionBinding, value: unknown, presenter: QuestionPresenter | undefined, signal?: AbortSignal): Promise<QuestionOutcome> {
    let questions: readonly Question[];
    try { questions = validateQuestions(value); }
    catch (error: unknown) { return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
    if (presenter === undefined) return { status: "unavailable", reason: "no interactive question channel is attached" };
    if (signal?.aborted) return { status: "cancelled", reason: "aborted" };
    if (this.activeRequestId !== undefined) return { status: "unavailable", reason: "another question is already active" };
    const requestId = randomUUID();
    this.activeRequestId = requestId;
    const prompt: QuestionPrompt = { ...binding, requestId, questions };
    let abortListener: (() => void) | undefined;
    try {
      const responsePromise = presenter(prompt, signal);
      if (signal === undefined) return validateReply(prompt, await responsePromise);
      const aborted = new Promise<{ readonly aborted: true }>(resolve => {
        abortListener = () => resolve({ aborted: true });
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      });
      const response = await Promise.race([responsePromise, aborted]);
      if ("aborted" in response || signal.aborted) return { status: "cancelled", reason: "aborted" };
      return validateReply(prompt, response);
    } catch (error: unknown) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
      if (this.activeRequestId === requestId) this.activeRequestId = undefined;
    }
  }
}

export function validateQuestions(value: unknown): readonly Question[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("questions" in value) || !Array.isArray(value.questions)) {
    throw new TypeError("Question input must contain a questions array.");
  }
  if (Object.keys(value).some(key => key !== "questions")) throw new TypeError("Question input contains an unknown field.");
  const raw = value.questions as unknown[];
  if (raw.length < 1 || raw.length > MAX_QUESTIONS) throw new TypeError(`Question count must be between 1 and ${MAX_QUESTIONS}.`);
  const ids = new Set<string>();
  return raw.map((item): Question => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError("Each question must be an object.");
    const question = item as Record<string, unknown>;
    const text = (candidate: unknown, label: string, max: number): string => {
      if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(candidate)) throw new TypeError(`${label} must be non-empty and at most ${max} characters.`);
      return candidate;
    };
    if (Object.keys(question).some(key => !["id", "header", "question", "options", "multiple", "allowFreeText"].includes(key))) throw new TypeError("Question contains an unknown field.");
    const id = text(question.id, "Question id", 48);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new TypeError("Question ids must be unique letters, digits, underscores, or hyphens.");
    ids.add(id);
    const header = text(question.header, "Question header", MAX_QUESTION_HEADER);
    const prompt = text(question.question, "Question text", MAX_QUESTION_TEXT);
    if (question.multiple !== undefined && typeof question.multiple !== "boolean") throw new TypeError("Question multiple must be a boolean.");
    if (question.allowFreeText !== undefined && typeof question.allowFreeText !== "boolean") throw new TypeError("Question allowFreeText must be a boolean.");
    let options: QuestionOption[] | undefined;
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > MAX_QUESTION_OPTIONS) throw new TypeError(`Question options must contain between 2 and ${MAX_QUESTION_OPTIONS} choices.`);
      options = question.options.map(optionValue => {
        if (typeof optionValue !== "object" || optionValue === null || Array.isArray(optionValue)) throw new TypeError("Question options must be objects.");
        const option = optionValue as Record<string, unknown>;
        if (Object.keys(option).some(key => key !== "label" && key !== "description")) throw new TypeError("Option contains an unknown field.");
        const label = text(option.label, "Option label", MAX_QUESTION_OPTION_LABEL);
        const description = option.description === undefined ? undefined : text(option.description, "Option description", MAX_QUESTION_TEXT);
        return { label, ...(description === undefined ? {} : { description }) };
      });
      if (new Set(options.map(option => option.label)).size !== options.length) throw new TypeError("Question option labels must be unique.");
    } else if (question.multiple === true) throw new TypeError("Multiple choice requires options.");
    return { id, header, question: prompt, ...(options === undefined ? {} : { options }), ...(question.multiple === undefined ? {} : { multiple: question.multiple as boolean }), ...(question.allowFreeText === undefined ? {} : { allowFreeText: question.allowFreeText as boolean }) };
  });
}

export function validateAnswers(questions: readonly Question[], value: unknown): readonly QuestionAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length) throw new TypeError("Answer must contain exactly one response for each question.");
  const byId = new Map(questions.map(question => [question.id, question]));
  const seen = new Set<string>();
  return value.map(raw => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("Each answer must be an object.");
    const answer = raw as Record<string, unknown>;
    if (Object.keys(answer).some(key => key !== "questionId" && key !== "value")) throw new TypeError("Answer contains an unknown field.");
    if (typeof answer.questionId !== "string" || seen.has(answer.questionId)) throw new TypeError("Answer question ids must be unique.");
    const question = byId.get(answer.questionId);
    if (question === undefined) throw new TypeError("Answer referenced an unknown question.");
    seen.add(question.id);
    const selected = Array.isArray(answer.value) ? answer.value : [answer.value];
    if (selected.length === 0 || selected.some(item => typeof item !== "string" || item.length === 0 || item.length > MAX_QUESTION_ANSWER)) throw new TypeError("Answer values must be non-empty and at most 2000 characters.");
    if (Array.isArray(answer.value) && question.multiple !== true) throw new TypeError("This question accepts one answer.");
    if (question.multiple === true && !Array.isArray(answer.value)) throw new TypeError("This question requires multiple answers.");
    if (Array.isArray(answer.value) && new Set(answer.value).size !== answer.value.length) throw new TypeError("Multiple choice answers must not repeat an option.");
    if (question.options !== undefined) for (const choice of selected as string[]) {
      if (!question.options.some(option => option.label === choice) && question.allowFreeText !== true) throw new TypeError("Answer must match a listed option.");
    }
    return { questionId: question.id, value: Array.isArray(answer.value) ? [...answer.value as string[]] : answer.value as string };
  });
}

function validateReply(prompt: QuestionPrompt, reply: Awaited<ReturnType<QuestionPresenter>>): QuestionOutcome {
  if ("status" in reply) return reply.status === "cancelled" ? { status: "cancelled", reason: "user" } : { status: "unavailable", reason: reply.reason };
  if (reply.requestId !== prompt.requestId || reply.runId !== prompt.runId || reply.toolCallId !== prompt.toolCallId) return { status: "unavailable", reason: "question answer did not match the active request" };
  try { return { status: "answered", answers: validateAnswers(prompt.questions, reply.answers) }; }
  catch (error: unknown) { return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
}
