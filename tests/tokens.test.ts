import { describe, expect, it } from "vitest";
import {
  addUsage,
  EMPTY_USAGE,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTokens,
  estimateToolTokens,
} from "../src/tokens.js";

describe("token estimation", () => {
  it("counts nothing for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("charges Latin text about four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("charges wide scripts about one token per character", () => {
    expect(estimateTokens("解释这个函数")).toBe(6);
  });

  it("mixes both scripts in one string", () => {
    expect(estimateTokens("read 文件")).toBe(Math.ceil(5 / 4) + 2);
  });

  it("charges an envelope per message", () => {
    expect(estimateMessageTokens({ role: "user", content: "" })).toBe(4);
  });

  it("counts assistant tool calls, not just text", () => {
    const withoutCalls = estimateMessageTokens({
      role: "assistant",
      content: "Reading the file.",
      toolCalls: [],
    });
    const withCalls = estimateMessageTokens({
      role: "assistant",
      content: "Reading the file.",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: { path: "src/agent.ts" } },
      ],
    });

    expect(withCalls).toBeGreaterThan(withoutCalls);
  });

  it("counts tool schemas, which are sent on every request", () => {
    expect(
      estimateToolTokens([
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ]),
    ).toBeGreaterThan(8);
  });

  it("adds up the whole request", () => {
    const request = {
      systemPrompt: "s".repeat(40),
      messages: [{ role: "user", content: "u".repeat(40) }] as const,
      tools: [],
    };

    expect(estimateRequestTokens(request)).toBe(10 + 4 + 10);
  });

  it("never under-counts a long transcript", () => {
    // Compacting early is cheap; a request over the real window is not.
    const text = "The quick brown fox jumps over the lazy dog. ";
    expect(estimateTokens(text.repeat(100))).toBeGreaterThanOrEqual(
      Math.floor((text.length * 100) / 5),
    );
  });
});

describe("usage totals", () => {
  it("adds reported usage and ignores absent usage", () => {
    const first = addUsage(EMPTY_USAGE, { inputTokens: 10, outputTokens: 5 });
    const second = addUsage(first, undefined);
    const third = addUsage(second, { inputTokens: 1, outputTokens: 2 });

    expect(first).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(second).toBe(first);
    expect(third).toEqual({ inputTokens: 11, outputTokens: 7 });
  });
});
