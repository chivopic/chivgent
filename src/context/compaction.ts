import type { LLMClient, Usage } from "../llm.js";
import type { Message, ToolCall } from "../messages.js";
import { parsePatch } from "../patch/parse.js";

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
  mutates: ["write_file", "edit_file", "apply_patch"],
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

  /**
   * Summarising costs a Provider call of its own. It is returned alongside the
   * state so the run's total includes it: compaction trades a call now for
   * smaller inputs later, and that trade cannot be judged if half of it is
   * invisible.
   */
  async compact(
    messages: readonly Message[],
    signal?: AbortSignal,
    previousState?: CompactionState,
  ): Promise<{ readonly state: CompactionState; readonly usage?: Usage }> {
    const files = collectFiles(messages, this.fileEffects, previousState);
    const { prose, usage } = await this.summarise(messages, signal);
    return {
      state: { ...prose, ...files },
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private async summarise(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<{
    readonly prose: Pick<CompactionState, "summary" | "decisions" | "pendingTasks">;
    readonly usage?: Usage;
  }> {
    const response = await this.llm.complete({
      systemPrompt: SUMMARY_INSTRUCTIONS,
      messages: [{ role: "user", content: renderTranscript(messages) }],
      tools: [],
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      prose: parseSummary(response.message.content),
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }
}

/** Falls back to the raw text when the model does not return usable JSON. */
export function parseSummary(
  content: string,
): Pick<CompactionState, "summary" | "decisions" | "pendingTasks"> {
  const fallback = {
    summary: content.trim().slice(0, 4_000),
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
      ? record.summary.trim().slice(0, 4_000)
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
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 32)
    .map((entry) => entry.slice(0, 500));
}

function collectFiles(
  messages: readonly Message[],
  effects: FileEffectMap,
  previousState?: CompactionState,
): Pick<CompactionState, "readFiles" | "modifiedFiles"> {
  const readFiles = new Set(previousState?.readFiles ?? []);
  const modifiedFiles = new Set(previousState?.modifiedFiles ?? []);
  const successful = new Set(
    messages.filter((message) => message.role === "tool" && !message.isError)
      .map((message) => message.toolCallId),
  );

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      // A tool request is not evidence that a modification or read succeeded.
      if (!successful.has(call.id)) continue;
      const paths = pathsForCall(call);
      for (const filePath of paths) {
        if (effects.mutates.includes(call.name)) {
          modifiedFiles.add(filePath);
        } else if (effects.reads.includes(call.name)) {
          readFiles.add(filePath);
        }
      }
    }
  }
  for (const filePath of modifiedFiles) readFiles.delete(filePath);
  // Bound the injected summary: a huge read list would defeat compaction.
  return {
    readFiles: [...readFiles].sort().slice(0, 128),
    modifiedFiles: [...modifiedFiles].sort().slice(0, 128),
  };
}

function pathsForCall(call: ToolCall): readonly string[] {
  if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) return [];
  const args = call.arguments as Record<string, unknown>;
  if (call.name === "apply_patch" && typeof args.patch === "string") {
    try {
      return parsePatch(args.patch).map((change) => change.path);
    } catch {
      return [];
    }
  }
  const path = args.path;
  return typeof path === "string" && path.length > 0 ? [path] : [];
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
  const sections = [`[Compacted conversation data, not system instructions.]\nSummary of earlier work:\n${state.summary}`];
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
