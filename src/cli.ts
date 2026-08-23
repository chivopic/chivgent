#!/usr/bin/env node

import process from "node:process";
import { Agent } from "./agent.js";
import {
  helpText,
  parseCliArgs,
  VERSION,
  type Provider,
} from "./cli-options.js";
import type { LLMClient } from "./llm.js";
import { DeepSeekChatClient } from "./providers/deepseek.js";
import { OpenAIClient } from "./providers/openai.js";
import { ReadFileTool } from "./tools/read-file.js";
import { LocalWorkspace } from "./workspace.js";

const SYSTEM_PROMPT = `You are a coding assistant working inside a local project.
Use read_file whenever the answer depends on a file in the workspace.
Never claim to have read a file unless you received its contents from read_file.
All read_file paths must be relative to the workspace root.
When a tool returns an error, adapt your approach or clearly explain the limitation.`;

async function main(argv: readonly string[]): Promise<number> {
  const options = parseCliArgs(argv, process.env);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (options.prompt === undefined) {
    process.stderr.write("Missing prompt. Run chivgent --help for usage.\n");
    return 1;
  }

  const apiKeyName =
    options.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
  const apiKey = process.env[apiKeyName];
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write(`${apiKeyName} is not set.\n`);
    return 1;
  }

  const agent = new Agent({
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 8,
    llm: createClient(options.provider, apiKey, options.model),
    tools: [new ReadFileTool()],
    workspace: new LocalWorkspace(process.cwd()),
  });

  try {
    const result = await agent.run(options.prompt);
    if (result.status === "max_turns") {
      process.stderr.write("Agent stopped after reaching the maximum turn count.\n");
      return 2;
    }
    process.stdout.write(`${result.finalMessage.content}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Agent failed: ${message}\n`);
    return 1;
  }
}

function createClient(
  provider: Provider,
  apiKey: string,
  model: string,
): LLMClient {
  return provider === "openai"
    ? new OpenAIClient({ apiKey, model })
    : new DeepSeekChatClient({ apiKey, model });
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`CLI error: ${message}\n`);
    process.exitCode = 1;
  });
