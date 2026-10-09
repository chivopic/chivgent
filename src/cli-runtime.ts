import type { AgentOptions } from "./agent.js";
import type { CliOptions } from "./cli-options.js";
import { ContextManager } from "./context/context-manager.js";
import { Compactor } from "./context/compaction.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { LLMClient } from "./llm.js";
import type { Message } from "./messages.js";
import { SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT } from "./prompts.js";
import { AgentSession } from "./session.js";
import { ShellApprovalGate } from "./shell/approval.js";
import type { SessionStore } from "./session-store.js";
import { BashTool } from "./tools/bash.js";
import { ApplyPatchTool } from "./tools/apply-patch.js";
import { EditFileTool } from "./tools/edit-file.js";
import { ListFilesTool } from "./tools/list-files.js";
import { ReadFileTool } from "./tools/read-file.js";
import { SearchTextTool } from "./tools/search-text.js";
import { WriteFileTool } from "./tools/write-file.js";
import { LocalWorkspace } from "./workspace.js";

interface LocalSessionConfig {
  readonly options: CliOptions;
  readonly cwd: string;
  readonly llm: LLMClient;
  readonly extensions?: ExtensionRegistry;
  readonly restored: {
    readonly id?: string;
    readonly messages?: readonly Message[];
    readonly resumed: boolean;
  };
  readonly store?: SessionStore;
  readonly shellApproval?: ShellApprovalGate;
}

/** Assemble the local agent once; cli.ts handles only process and UI lifecycle. */
export function createLocalSession(config: LocalSessionConfig): AgentSession {
  const { options, cwd, llm, extensions, restored, store } = config;
  const prompt = [SYSTEM_PROMPT];
  if (options.allowWrites) prompt.push(WRITE_SYSTEM_PROMPT);
  if (options.allowShell) prompt.push(SHELL_SYSTEM_PROMPT);
  prompt.push(...(extensions?.systemPromptContributions ?? []));

  const contextManager = new ContextManager({
    contextWindow: options.contextWindow,
    ...(options.compaction ? { compactor: new Compactor(llm) } : {}),
    onCompaction: ({ droppedMessages, tokensBefore, tokensAfter }) => {
      if (!options.quiet) {
        process.stderr.write(
          `Compacted ${droppedMessages} earlier messages (~${tokensBefore} -> ~${tokensAfter} tokens).\n`,
        );
      }
    },
  });

  const agent: Omit<AgentOptions, "onEvent"> = {
    systemPrompt: prompt.join("\n"),
    maxTurns: options.maxTurns,
    llm,
    tools: [
      new ListFilesTool(),
      new SearchTextTool(),
      new ReadFileTool(),
      ...(options.allowWrites ? [new WriteFileTool(), new EditFileTool(), new ApplyPatchTool()] : []),
      ...(options.allowShell ? [new BashTool({
        cwd,
        approve: (command, signal) => config.shellApproval?.approve(command, signal) ?? Promise.resolve(false),
      })] : []),
      ...(extensions?.registeredTools ?? []).map((entry) => entry.tool),
    ],
    workspace: new LocalWorkspace(cwd, { allowWrites: options.allowWrites }),
    streaming: options.stream,
    contextManager,
  };
  return new AgentSession({
    agent,
    cwd,
    resumed: restored.resumed,
    ...(restored.id === undefined ? {} : { id: restored.id }),
    ...(restored.messages === undefined ? {} : { messages: restored.messages }),
    ...(store === undefined ? {} : { store }),
  });
}
