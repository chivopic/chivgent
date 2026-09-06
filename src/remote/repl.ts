import { createInterface } from "node:readline";
import type { OutputStream } from "../render.js";
import { REPL_PROMPT } from "../repl.js";
import type { RemoteSession } from "./client.js";

export interface RemoteReplOptions {
  readonly remote: RemoteSession;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly stderr: OutputStream;
  readonly socketPath: string;
}

const HELP = `Commands:
  /help      Show this help
  /session   Show the served session's id, workspace and capabilities
  /tools     List the tools the server offers
  /exit      Leave this client (the server keeps running)

Anything else is sent to the server. Ctrl+C interrupts the answer in progress.
`;

/**
 * The interactive loop for an attached client.
 *
 * It deliberately offers fewer commands than the local REPL: /clear would
 * change a transcript this process does not own, and other clients would see
 * it happen without asking.
 */
export async function runRemoteRepl(
  options: RemoteReplOptions,
): Promise<number> {
  const write = (text: string): void => {
    options.stderr.write(text);
  };
  const readline = createInterface({
    input: options.input,
    output: options.output,
    terminal: true,
    prompt: REPL_PROMPT,
  });

  let running = false;
  readline.on("SIGINT", () => {
    if (!running) {
      write("Press Ctrl+D or /exit to leave.\n");
      readline.prompt();
      return;
    }
    options.remote.interrupt();
  });

  const summary = options.remote.session;
  write(
    [
      `attached to ${summary.id}`,
      `workspace:    ${summary.cwd}`,
      `capabilities: ${summary.capabilities.length === 0 ? "read-only" : summary.capabilities.join(" ")}`,
      "Type /help for commands, Ctrl+D to detach.",
      "",
      "",
    ].join("\n"),
  );
  readline.prompt();

  for await (const line of readline) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      readline.prompt();
      continue;
    }

    if (trimmed.startsWith("/")) {
      const command = trimmed.split(/\s+/, 1)[0];
      if (command === "/exit" || command === "/quit") {
        break;
      }
      if (command === "/help" || command === "/?") {
        write(HELP);
      } else if (command === "/session") {
        write(
          [
            `id:           ${summary.id}`,
            `workspace:    ${summary.cwd}`,
            `socket:       ${options.socketPath}`,
            `capabilities: ${summary.capabilities.length === 0 ? "read-only" : summary.capabilities.join(" ")}`,
            "",
          ].join("\n"),
        );
      } else if (command === "/tools") {
        write(`${options.remote.toolNames.map((name) => `  ${name}`).join("\n")}\n`);
      } else {
        write(`Unknown command: ${trimmed}. Try /help.\n`);
      }
      readline.prompt();
      continue;
    }

    running = true;
    try {
      await options.remote.prompt(trimmed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      write(`${message}\n`);
      // A dead server ends the client; a busy or agent error does not.
      if (message.includes("closed the connection")) {
        readline.close();
        return 1;
      }
    } finally {
      running = false;
    }
    readline.prompt();
  }

  readline.close();
  return 0;
}
