import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../src/llm.js";
import { OpenAIClient } from "../src/providers/openai.js";
import { ListFilesTool } from "../src/tools/list-files.js";
import { ReadFileTool } from "../src/tools/read-file.js";
import { SearchTextTool } from "../src/tools/search-text.js";

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

describe("OpenAIClient", () => {
  it("maps an initial request and function call across the Provider boundary", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-1",
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"src/agent.ts"}',
        },
      ],
    });
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });

    const result = await client.complete({
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "Explain src/agent.ts" }],
      tools,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        instructions: "System prompt",
        input: [{ role: "user", content: "Explain src/agent.ts" }],
        parallel_tool_calls: false,
        stream: false,
        tools: [
          expect.objectContaining({
            type: "function",
            name: "read_file",
            strict: true,
          }),
        ],
      }),
    );
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
    expect(result.continuation).toEqual({
      provider: "openai-responses",
      previousResponseId: "resp-1",
    });
  });

  it("continues with only pending tool results and the previous response id", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-2",
      output_text: "The file owns the Agent Loop.",
      output: [{ type: "message" }],
    });
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });

    const result = await client.complete({
      systemPrompt: "System prompt",
      messages: [
        { role: "user", content: "Explain src/agent.ts" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "read_file",
              arguments: { path: "src/agent.ts" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          content: "file contents",
          isError: false,
        },
      ],
      tools,
      continuation: {
        provider: "openai-responses",
        previousResponseId: "resp-1",
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_response_id: "resp-1",
        input: [
          {
            type: "function_call_output",
            call_id: "call-1",
            output: "file contents",
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

  it("marks failed tool output explicitly for the model", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-2",
      output_text: "The file was unavailable.",
      output: [],
    });
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
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
        provider: "openai-responses",
        previousResponseId: "resp-1",
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          expect.objectContaining({
            output: "Tool error: File does not exist: missing.ts",
          }),
        ],
      }),
    );
  });

  it("rejects continuation data from another Provider", async () => {
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create: vi.fn() } } as unknown as OpenAI,
    });

    await expect(
      client.complete({
        systemPrompt: "System prompt",
        messages: [{ role: "user", content: "Question" }],
        tools,
        continuation: { provider: "other" },
      }),
    ).rejects.toThrow("incompatible continuation");
  });

  it("maps every discovery tool as a strict function schema", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "resp-tools",
      output_text: "Done",
      output: [{ type: "message" }],
    });
    const client = new OpenAIClient({
      apiKey: "test-key",
      model: "test-model",
      client: { responses: { create } } as unknown as OpenAI,
    });
    const discoveryTools = [
      new ListFilesTool(),
      new SearchTextTool(),
      new ReadFileTool(),
    ];

    await client.complete({
      systemPrompt: "System prompt",
      messages: [{ role: "user", content: "Explain this project" }],
      tools: discoveryTools,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: discoveryTools.map((tool) =>
          expect.objectContaining({
            type: "function",
            name: tool.name,
            parameters: tool.inputSchema,
            strict: true,
          }),
        ),
      }),
    );
    for (const tool of discoveryTools) {
      expect(tool.inputSchema.required).toEqual(
        Object.keys(tool.inputSchema.properties),
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});
