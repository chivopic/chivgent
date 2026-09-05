import type { LLMClient } from "../llm.js";
import type { Message, ToolCall } from "../messages.js";

export interface CompactionState {
  readonly summary: string;
  /** Files the agent read, derived from tool calls rather than from prose. */
  readonly readFiles: readonly string[];
  /** Files the agent changed, derived from tool calls rather than from prose. */
  readonly modifiedFiles: readonly string[];
  readonly decisions: readonly string[];
  readonly pendingTasks: readonly string[];
}

/**
 * Which tool names touch which files.
 *
 * File lists are derived from the tool calls themselves instead of being
 * summarised by the model. A summary can forget or invent a path; the calls
 * cannot. For a coding agent this is the part of the history that most needs
 * to survive compaction intact.
 */
export interface FileEffectMap {
  readonly reads: readonly string[];
  readonly mutates: readonly string[];
}

export const DEFAULT_FILE_EFFECTS: FileEffectMap = {
  reads: ["read_file"],
  mutates: ["write_file", "edit_file"],
};

const SUMMARY_INSTRUCTIONS = `You are compacting an engineering conversation so it can continue in a smaller context.
Reply with JSON only, no code fence, matching:
{"summary": string, "decisions": string[], "pendingTasks": string[]}
summary: what was asked and what was established, in a few sentences.
decisions: choices that later work must respect.
pendingTasks: work that was identified but not finished.
Omit file lists; they are tracked separately.`;

export interface CompactorOptions {
  readonly fileEffects?: FileEffectMap;
}

export class Compactor {
  private readonly fileEffects: FileEffectMap;

  constructor(
    private readonly llm: LLMClient,
    options: CompactorOptions = {},
  ) {
    this.fileEffects = options.fileEffects ?? DEFAULT_FILE_EFFECTS;
  }

  async compact(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<CompactionState> {
    const files = collectFiles(messages, this.fileEffects);
    const prose = await this.summarise(messages, signal);
    return { ...prose, ...files };
  }

  private async summarise(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<Pick<CompactionState, "summary" | "decisions" | "pendingTasks">> {
    const response = await this.llm.complete({
      systemPrompt: SUMMARY_INSTRUCTIONS,
      messages: [{ role: "user", content: renderTranscript(messages) }],
      tools: [],
      ...(signal === undefined ? {} : { signal }),
    });
    return parseSummary(response.message.content);
  }
}

/** Falls back to the raw text when the model does not return usable JSON. */
export function parseSummary(
  content: string,
): Pick<CompactionState, "summary" | "decisions" | "pendingTasks"> {
  const fallback = {
    summary: content.trim(),
    decisions: [] as readonly string[],
    pendingTasks: [] as readonly string[],
  };

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallback;
  }

  const record = parsed as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary.trim()
      : fallback.summary;
  return {
    summary,
    decisions: stringList(record.decisions),
    pendingTasks: stringList(record.pendingTasks),
  };
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function collectFiles(
  messages: readonly Message[],
  effects: FileEffectMap,
): Pick<CompactionState, "readFiles" | "modifiedFiles"> {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls) {
      const filePath = pathArgument(call);
      if (filePath === undefined) {
        continue;
      }
      if (effects.mutates.includes(call.name)) {
        modifiedFiles.add(filePath);
      } else if (effects.reads.includes(call.name)) {
        readFiles.add(filePath);
      }
    }
  }

  // A file that was changed is more relevant as "changed" than as "read".
  for (const filePath of modifiedFiles) {
    readFiles.delete(filePath);
  }
  return {
    readFiles: [...readFiles].sort(),
    modifiedFiles: [...modifiedFiles].sort(),
  };
}

function pathArgument(call: ToolCall): string | undefined {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return undefined;
  }
  const value = (call.arguments as Record<string, unknown>).path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function renderTranscript(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      if (message.role === "assistant") {
        const calls = message.toolCalls
          .map((call) => `\n[tool call] ${call.name} ${JSON.stringify(call.arguments)}`)
          .join("");
        return `assistant: ${message.content}${calls}`;
      }
      if (message.role === "tool") {
        return `[tool result] ${message.toolName}${message.isError ? " (error)" : ""}: ${message.content}`;
      }
      return `user: ${message.content}`;
    })
    .join("\n\n");
}

/** Renders compaction state as the single message that replaces the history. */
export function renderCompactionState(state: CompactionState): string {
  const sections = [`Summary of earlier work:\n${state.summary}`];
  if (state.readFiles.length > 0) {
    sections.push(`Files read:\n${state.readFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (state.modifiedFiles.length > 0) {
    sections.push(
      `Files modified:\n${state.modifiedFiles.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (state.decisions.length > 0) {
    sections.push(`Decisions to respect:\n${state.decisions.map((d) => `- ${d}`).join("\n")}`);
  }
  if (state.pendingTasks.length > 0) {
    sections.push(`Still pending:\n${state.pendingTasks.map((t) => `- ${t}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
