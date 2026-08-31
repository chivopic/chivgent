import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/llm.js";
import { DeepSeekChatClient } from "../src/providers/deepseek.js";
import { OpenAIClient } from "../src/providers/openai.js";

const tools: LLMRequest["tools"] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

const request: LLMRequest = {
  systemPrompt: "System prompt",
  messages: [{ role: "user", content: "Explain src/agent.ts" }],
  tools,
};

async function* iterate<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
}

function collect(): {
  readonly deltas: string[];
  readonly handlers: { onTextDelta: (delta: string) => void };
} {
  const deltas: string[] = [];
  return { deltas, handlers: { onTextDelta: (delta) => deltas.push(delta) } };
}

describe("OpenAIClient streaming", () => {
  it("emits text deltas and resolves with the completed response", async () => {
    const create = vi.fn().mockResolvedValue(
      iterate([
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        {
          type: "response.completed",
          response: { id: "resp-1", output_text: "Hello", output: [] },
        },
      ]),
    );
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });
    const { deltas, handlers } = collect();

    const result = await client.stream(request, handlers);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "Hello",
      toolCalls: [],
    });
    expect(result.continuation).toEqual({
      provider: "openai-responses",
      previousResponseId: "resp-1",
    });
  });

  it("passes the abort signal to the Provider", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      iterate([
        {
          type: "response.completed",
          response: { id: "resp-1", output_text: "Hello", output: [] },
        },
      ]),
    );
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });

    await client.stream(
      { ...request, signal: controller.signal },
      collect().handlers,
    );

    expect(create).toHaveBeenCalledWith(expect.objectContaining({}), {
      signal: controller.signal,
    });
  });

  it("rejects a stream that never completes", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        iterate([{ type: "response.output_text.delta", delta: "Hello" }]),
      );
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });

    await expect(client.stream(request, collect().handlers)).rejects.toThrow(
      "without a completed response",
    );
  });
});

describe("OpenAI-compatible streaming", () => {
  it("rebuilds one assistant message from chunks", async () => {
    const create = vi.fn().mockResolvedValue(
      iterate([
        { choices: [{ delta: { role: "assistant", content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });
    const { deltas, handlers } = collect();

    const result = await client.stream(request, handlers);

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "Hello",
      toolCalls: [],
    });
  });

  it("assembles tool call fragments by stream index", async () => {
    const create = vi.fn().mockResolvedValue(
      iterate([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"pa' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'th":"src/agent.ts"}' },
                  },
                ],
              },
            },
          ],
        },
      ]),
    );
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });

    const result = await client.stream(request, collect().handlers);

    expect(result.message.toolCalls).toEqual([
      {
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/agent.ts" },
      },
    ]);
  });

  it("keeps streamed reasoning in the continuation history", async () => {
    const create = vi.fn().mockResolvedValue(
      iterate([
        {
          choices: [
            { delta: { reasoning_content: "Think" } },
          ],
        },
        { choices: [{ delta: { content: "Answer." } }] },
      ]),
    );
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });

    const result = await client.stream(request, collect().handlers);

    expect(result.continuation).toMatchObject({
      provider: "deepseek-chat",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Explain src/agent.ts" },
        {
          role: "assistant",
          content: "Answer.",
          reasoning_content: "Think",
        },
      ],
    });
  });

  it("rejects a tool call that never received an id", async () => {
    const create = vi.fn().mockResolvedValue(
      iterate([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "{}" } },
                ],
              },
            },
          ],
        },
      ]),
    );
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });

    await expect(client.stream(request, collect().handlers)).rejects.toThrow(
      "incomplete tool call",
    );
  });
});
