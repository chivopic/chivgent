import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMAbortError, type LLMRequest } from "../src/llm.js";
import { runRepl } from "../src/repl.js";
import { AgentSession } from "../src/session.js";
import { LocalWorkspace } from "../src/workspace.js";
import { createLiveRegion } from "../src/tui/live.js";
import { TuiInput } from "../src/tui/input.js";
import { displayWidth, fitLine, terminalText } from "../src/tui/text.js";
import { welcome } from "../src/tui/welcome.js";

afterEach(() => vi.unstubAllEnvs());

class Input extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(enabled: boolean) { this.raw = enabled; return this; }
}

it("fits terminal cells without splitting graphemes or executing controls", () => {
  expect(fitLine("中文测试", 5)).toBe("中文…");
  expect(fitLine("👩‍💻👩‍💻x", 3)).toBe("👩‍💻…");
  expect(fitLine("e\u0301e\u0301xy", 3)).toBe("e\u0301e\u0301…");
  expect(fitLine("hello", 1)).toBe("…");
  expect(fitLine("hello", 0)).toBe("");
  expect(terminalText("\x1b[2Jhello\r\nworld\x07")).toBe("hello\nworld");
  expect(fitLine("a\tb\rc\n", 20)).not.toMatch(/[\t\r\n]/);
});

it("keeps the welcome panel within very narrow and Unicode terminal widths", () => {
  for (const width of [5, 12, 30, 80, 140]) {
    const banner = welcome({ version: "test", provider: "demo", model: "模型😀", cwd: "/项目/测试", sessionId: "demo", resumed: true, signedOut: true, width });
    expect(banner.split("\n").every((line) => displayWidth(line) < width)).toBe(true);
  }
});

it("keeps reading Ctrl+C while dropping busy input and restores raw mode", async () => {
  const source = new Input();
  const gate = new TuiInput(source);
  let received = "";
  gate.on("data", (chunk) => { received += chunk.toString(); });
  gate.setRawMode(true);
  source.write("hello");
  gate.setBusy(true);
  source.write("ignored\n");
  source.write(Buffer.from("ignored\x03more"));
  gate.setBusy(false);
  source.write("again");
  expect(received).toBe("hello\x03again");
  gate.dispose();
  expect(source.raw).toBe(false);
  expect(source.listenerCount("data")).toBe(0);
});

it("latches submission across chunks and consumes a split CRLF only once", () => {
  const source = new Input();
  const gate = new TuiInput(source);
  let received = "";
  gate.on("data", (chunk) => { received += chunk.toString(); });
  try {
    source.write("first\r");
    source.write("queued\r");
    expect(received).toBe("first\r");
    gate.acceptLine();
    source.write("second\r");
    gate.acceptLine();
    source.write("\nthird\r\nfourth\n");
    source.write("also queued\n");
    expect(received).toBe("first\rsecond\rthird\r");
    gate.acceptLine();
    source.write("final\n");
    expect(received).toBe("first\rsecond\rthird\rfinal\n");
  } finally { gate.dispose(); }
});

describe("TUI REPL", () => {
  it("keeps /login entry hidden and restores the prompt afterwards", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const submitted: string[] = [];
    const session = new AgentSession({ agent: {
      systemPrompt: "demo", maxTurns: 1, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete() { throw new Error("No provider call expected"); } },
    } });
    const result = runRepl({ session, input, output, stderr: output, tui: true,
      signIn: { provider: "demo", authFile: "/unused", ready: () => false,
        submit: async (key) => { submitted.push(key); return undefined; },
      },
    });
    try {
      input.write("/login\r");
      await vi.waitFor(() => expect(screen).toContain("API key: "));
      input.write("demo-key-no-network\r");
      await vi.waitFor(() => expect(screen).toContain("Stored the key"));
      expect(submitted).toEqual(["demo-key-no-network"]);
      expect(screen).not.toContain("demo-key-no-network");
      input.write("/exit\r");
      expect(await result).toBe(0);
      expect(input.raw).toBe(false);
    } finally {
      input.end();
      await result;
    }
  });

  it("completes commands, cancels a run, ignores busy typing, and accepts another prompt", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = new Input();
    const output = new PassThrough();
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    const requests: string[] = [];
    let running = false;
    const session = new AgentSession({ cwd: process.cwd(), agent: {
      systemPrompt: "demo", maxTurns: 3, tools: [], workspace: new LocalWorkspace(process.cwd()),
      llm: { async complete(request: LLMRequest) {
        requests.push(request.messages.at(-1)?.content ?? "");
        if (requests.length === 1) {
          running = true;
          await new Promise<void>((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(new LLMAbortError()), { once: true });
          });
        }
        return { message: { role: "assistant" as const, content: "answer", toolCalls: [] } };
      } },
    } });
    const region = createLiveRegion({ stream: output, width: () => 80 });
    session.subscribe(region.listener);
    const result = runRepl({ session, input, output, stderr: output, tui: true });
    try {
      input.write("/he");
      input.write("\t");
      input.write("\r");
      await vi.waitFor(() => expect(screen).toContain("Commands:"));
      input.write("first\r");
      await vi.waitFor(() => expect(running).toBe(true));
      input.write("DO_NOT_ECHO\r");
      expect(screen).not.toContain("DO_NOT_ECHO");
      input.write("\x03");
      await vi.waitFor(() => expect(screen).toContain("Stopped"));
      input.write("second\r");
      await vi.waitFor(() => expect(screen).toContain("Completed"));
      expect(requests).toEqual(["first", "second"]);
      input.write("\x04");
      expect(await result).toBe(0);
      expect(input.raw).toBe(false);
      expect(input.listenerCount("data")).toBe(0);
    } finally {
      input.end();
      region.stop();
      await result;
    }
  });
});
