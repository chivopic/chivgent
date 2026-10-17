import { randomBytes } from "node:crypto";
import { Agent } from "@chivgent/agent.ts";
import type { AgentEventListener } from "@chivgent/events.ts";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamHandlers,
} from "@chivgent/llm.ts";
import type { AssistantMessage } from "@chivgent/messages.ts";
import type { Tool } from "@chivgent/tools/tool.ts";
import { LocalWorkspace } from "@chivgent/workspace.ts";

/**
 * Offline stub that walks the real Agent loop. The script matches
 * scripts/tui-demo.mjs: streamed text, one read-only tool, then a final answer.
 * Nothing here writes the workspace.
 */
export interface DemoTiming {
  readonly textDelayMs: number;
  readonly toolDelayMs: number;
  readonly finalDelayMs: number;
}

export const VISIBLE_DEMO_TIMING: DemoTiming = {
  textDelayMs: 280,
  toolDelayMs: 400,
  finalDelayMs: 70,
};

export const FAST_DEMO_TIMING: DemoTiming = {
  textDelayMs: 5,
  toolDelayMs: 15,
  finalDelayMs: 5,
};

const FIRST_DELTAS = ["我会", "检查当前任务。", " Testing Unicode: 👩‍💻 中文。"] as const;
const FIRST_TEXT = FIRST_DELTAS.join("");
const FINAL_TEXT =
  "演示完成。\nThis response came from an offline stub provider.\nTry another prompt, or stop a run while the tool is still checking.";

export function createDemoWorkspace(root: string): LocalWorkspace {
  return new LocalWorkspace(root);
}

export function createDemoAgent(options: {
  readonly workspaceRoot: string;
  readonly timing?: DemoTiming;
  readonly onEvent?: AgentEventListener;
}): Agent {
  const timing = options.timing ?? VISIBLE_DEMO_TIMING;
  let toolCallSequence = 0;
  const llm = createStubClient(timing, () => {
    toolCallSequence += 1;
    return `demo-${toolCallSequence}-${randomBytes(3).toString("hex")}`;
  });
  const tool = createDemoProgressTool(timing.toolDelayMs);
  return new Agent({
    llm,
    systemPrompt: "offline demo",
    maxTurns: 4,
    streaming: true,
    workspace: createDemoWorkspace(options.workspaceRoot),
    tools: [tool],
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
}

function createStubClient(
  timing: DemoTiming,
  nextToolCallId: () => string,
): LLMClient {
  return {
    async complete(request: LLMRequest): Promise<LLMResponse> {
      return streamedReply(request, timing, nextToolCallId, undefined);
    },
    async stream(
      request: LLMRequest,
      handlers: LLMStreamHandlers,
    ): Promise<LLMResponse> {
      return streamedReply(request, timing, nextToolCallId, handlers);
    },
  };
}

async function streamedReply(
  request: LLMRequest,
  timing: DemoTiming,
  nextToolCallId: () => string,
  handlers: LLMStreamHandlers | undefined,
): Promise<LLMResponse> {
  const last = request.messages.at(-1);
  if (last?.role !== "tool") {
    await emitDeltas(FIRST_DELTAS, timing.textDelayMs, request.signal, handlers);
    return {
      message: assistant(FIRST_TEXT, [
        { id: nextToolCallId(), name: "demo_progress", arguments: {} },
      ]),
    };
  }
  const pieces = FINAL_TEXT.split(/(?<=\s)/);
  await emitDeltas(pieces, timing.finalDelayMs, request.signal, handlers);
  return {
    message: assistant(FINAL_TEXT, []),
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
  };
}

async function emitDeltas(
  deltas: readonly string[],
  delayMs: number,
  signal: AbortSignal | undefined,
  handlers: LLMStreamHandlers | undefined,
): Promise<void> {
  for (const delta of deltas) {
    await wait(delayMs, signal);
    handlers?.onTextDelta(delta);
  }
}

function createDemoProgressTool(delayMs: number): Tool {
  return {
    name: "demo_progress",
    description: "Simulated progress; changes no files.",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_args, context) {
      for (let step = 1; step <= 3; step += 1) {
        await wait(delayMs, context.signal);
        context.onUpdate?.(`Checking ${step}/3 · 中文 output`);
      }
      return { content: "Demo checks passed.", isError: false };
    },
  };
}

function assistant(
  content: string,
  toolCalls: AssistantMessage["toolCalls"],
): AssistantMessage {
  return { role: "assistant", content, toolCalls };
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
