import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteSession } from "../src/remote/client.js";
import { runRemoteRepl } from "../src/remote/repl.js";

afterEach(() => vi.unstubAllEnvs());

class Input extends PassThrough {
  isTTY = true;
  setRawMode(_enabled: boolean): this { return this; }
}

it("detaches on idle Ctrl+C and interrupts only an active remote run", async () => {
  vi.stubEnv("TERM", "xterm-256color");
  const input = new Input();
  const output = new PassThrough();
  let screen = "";
  output.on("data", (chunk) => { screen += chunk.toString(); });
  let finishRun: (() => void) | undefined;
  const prompt = vi.fn(async () => new Promise<void>((resolve) => { finishRun = resolve; }));
  const interrupt = vi.fn(() => finishRun?.());
  const remote = {
    session: { id: "remote-test", cwd: "/workspace", capabilities: [] },
    toolNames: [], prompt, interrupt,
  } as unknown as RemoteSession;
  const result = runRemoteRepl({ remote, input, output, stderr: output, socketPath: "/unused" });
  try {
    input.write("hello\r");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("hello"));
    input.write("\x03");
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(screen.split("› ").length).toBeGreaterThan(2));
    input.write("\x03");
    expect(await result).toBe(130);
  } finally { input.end(); await result; }
});
