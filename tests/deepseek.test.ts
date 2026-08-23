import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/llm.js";
import { DeepSeekChatClient } from "../src/providers/deepseek.js";

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

describe("DeepSeekChatClient", () => {
  it("maps an initial request and preserves reasoning in continuation", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "I need to inspect the file.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"src/agent.ts"}',
                },
              },
            ],
          },
        },
      ],
    });
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });

    const result = await client.complete({
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "Explain src/agent.ts" }],
      tools,
    });

    expect(create).toHaveBeenCalledWith({
      model: "deepseek-test",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Explain src/agent.ts" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: tools[0]?.inputSchema,
          },
        },
      ],
      stream: false,
    });
    expect(result.message).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "read_file",
          arguments: { path: "src/agent.ts" },
        },
      ],
    });
    expect(result.message).not.toHaveProperty("reasoning_content");
    expect(result.continuation).toMatchObject({
      provider: "deepseek-chat",
      systemPrompt: "System prompt",
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          reasoning_content: "I need to inspect the file.",
        },
      ],
    });
  });

  it("replays Provider history and appends tool results", async () => {
    const firstCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect it.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"src/agent.ts"}',
                },
              },
            ],
          },
        },
      ],
    });
    const firstClient = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: {
        chat: { completions: { create: firstCreate } },
      } as unknown as OpenAI,
    });
    const first = await firstClient.complete({
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "Explain src/agent.ts" }],
      tools,
    });

    const secondCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: "The file owns the Agent Loop.",
            reasoning_content: "The contents are sufficient.",
          },
        },
      ],
    });
    const secondClient = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: {
        chat: { completions: { create: secondCreate } },
      } as unknown as OpenAI,
    });

    const result = await secondClient.complete({
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "Explain src/agent.ts" },
        first.message,
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "file contents",
          isError: false,
        },
      ],
      tools,
      continuation: first.continuation,
    });

    expect(secondCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "System prompt" },
          { role: "user", content: "Explain src/agent.ts" },
          expect.objectContaining({
            role: "assistant",
            reasoning_content: "Inspect it.",
            tool_calls: expect.any(Array),
          }),
          {
            role: "tool",
            tool_call_id: "call-1",
            content: "file contents",
          },
        ],
      }),
    );
    expect(result.message).toEqual({
      role: "assistant",
      content: "The file owns the Agent Loop.",
      toolCalls: [],
    });
  });

  it("marks failed tool results explicitly", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        { message: { role: "assistant", content: "File unavailable." } },
      ],
    });
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: { chat: { completions: { create } } } as unknown as OpenAI,
    });

    await client.complete({
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "Read missing.ts" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "missing.ts" } },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "File does not exist: missing.ts",
          isError: true,
        },
      ],
      tools,
      continuation: {
        provider: "deepseek-chat",
        systemPrompt: "System prompt",
        messages: [
          { role: "system", content: "System prompt" },
          { role: "user", content: "Read missing.ts" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect it.",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"missing.ts"}',
                },
              },
            ],
          },
        ],
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: "tool",
            tool_call_id: "call-1",
            content: "Tool error: File does not exist: missing.ts",
          },
        ]),
      }),
    );
  });

  it("rejects continuation data from another Provider", async () => {
    const client = new DeepSeekChatClient({
      apiKey: "test-key",
      model: "deepseek-test",
      client: {
        chat: { completions: { create: vi.fn() } },
      } as unknown as OpenAI,
    });

    await expect(
      client.complete({
        systemPrompt: "System prompt",
        messages: [{ role: "user", content: "Question" }],
        tools,
        continuation: { provider: "openai-responses" },
      }),
    ).rejects.toThrow("incompatible continuation");
  });
});
