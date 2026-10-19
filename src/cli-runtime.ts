import type { AgentOptions } from "./agent.js";
import type { CliOptions } from "./cli-options.js";
import { ContextManager } from "./context/context-manager.js";
import { Compactor } from "./context/compaction.js";
import { ScopedProjectInstructions } from "./context/project-instructions.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { LLMClient } from "./llm.js";
import type { Message } from "./messages.js";
import type { AppliedCompaction } from "./context/context-manager.js";
import type { UsageTotal } from "./providers/usage.js";
import { SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT, WEB_SEARCH_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT } from "./prompts.js";
import { AgentSession } from "./session.js";
import { ShellApprovalGate } from "./shell/approval.js";
import { PermissionWorkspace, type PermissionPolicy } from "./permissions.js";
import { createShellOperations } from "./shell/factory.js";
import type { SessionStore } from "./session-store.js";
import { BashTool } from "./tools/bash.js";
import { ApplyPatchTool } from "./tools/apply-patch.js";
import { EditFileTool } from "./tools/edit-file.js";
import { ListFilesTool } from "./tools/list-files.js";
import { ReadFileTool } from "./tools/read-file.js";
import { SearchTextTool } from "./tools/search-text.js";
import { WebSearchTool } from "./tools/web-search.js";
import { WriteFileTool } from "./tools/write-file.js";
import { UpdatePlanTool } from "./tools/update-plan.js";
import { SearxngBackend } from "./websearch/backend.js";
import { LocalWorkspace } from "./workspace.js";

interface LocalSessionConfig {
  readonly options: CliOptions;
  readonly cwd: string;
  readonly llm: LLMClient;
  readonly extensions?: ExtensionRegistry;
  readonly restored: {
    readonly id?: string;
    readonly messages?: readonly Message[];
    readonly compaction?: AppliedCompaction;
    readonly promptCount?: number;
    readonly usage?: UsageTotal;
    readonly title?: string;
    readonly planMode?: boolean;
    readonly resumed: boolean;
  };
  readonly store?: SessionStore;
  readonly shellApproval?: ShellApprovalGate;
  readonly permissionPolicy?: PermissionPolicy;
}

/** Assemble the local agent once; cli.ts handles only process and UI lifecycle. */
export function createLocalSession(config: LocalSessionConfig): AgentSession {
  const { options, cwd, llm, extensions, restored, store } = config;
  const prompt = [SYSTEM_PROMPT];
  const modernPolicy = config.permissionPolicy !== undefined;
  const allowWrites = modernPolicy || options.allowWrites;
  const allowShell = modernPolicy || options.allowShell;
  const webSearchBackend = options.webSearch === undefined
    ? undefined
    : new SearxngBackend({
        baseURL: options.webSearch.url,
        ...(options.webSearch.token === undefined ? {} : { token: options.webSearch.token }),
      });
  if (allowWrites) prompt.push(WRITE_SYSTEM_PROMPT);
  if (allowShell) prompt.push(SHELL_SYSTEM_PROMPT);
  if (webSearchBackend !== undefined) prompt.push(WEB_SEARCH_SYSTEM_PROMPT);
  if (modernPolicy) prompt.push(`A process-local permission policy governs file changes, shell commands, web search, and extension tools; its mode can change during the conversation and is not restored from a saved session. For files or network outside the workspace, request bash with scope "host" and explain why in justification; this asks for one-command broad host access. Never retry denied actions using another tool.`);
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
      ...(webSearchBackend === undefined ? [] : [new WebSearchTool({
        backend: webSearchBackend,
        ...(modernPolicy ? {
          authorize: (query: string, signal?: AbortSignal) =>
            config.permissionPolicy!.authorizeWebSearch(query, webSearchBackend.name, signal),
        } : {}),
      })]),
      new ReadFileTool(),
      new UpdatePlanTool(),
      ...(allowWrites ? [new WriteFileTool(), new EditFileTool(), new ApplyPatchTool()] : []),
      ...(allowShell ? [new BashTool({
        cwd,
        allowWrites,
        allowNetwork: modernPolicy ? config.permissionPolicy!.shellNetwork : options.shellNetwork,
        backend: options.shellBackend,
        ...(modernPolicy ? {
          operationsForCall: (scope: "workspace" | "host" = "workspace") => createShellOperations({ backend: options.shellBackend, allowWrites: true, allowNetwork: scope === "host" || config.permissionPolicy!.shellNetwork, allowHostAccess: scope === "host" }),
          defaultScopeForCall: () => config.permissionPolicy!.mode === "unrestricted" ? "host" as const : "workspace" as const,
        } : {}),
        approve: modernPolicy
          ? (command, signal, context) => config.permissionPolicy!.authorizeShell(command, context?.startsWith("Expanded host access") ? "host" : "workspace", signal, context)
          : (command, signal, context) => config.shellApproval?.approve(command, signal, context) ?? Promise.resolve(false),
      })] : []),
      ...(extensions?.registeredTools ?? []).map((entry) => entry.tool),
    ],
    workspace: modernPolicy ? new PermissionWorkspace(cwd, config.permissionPolicy!) : new LocalWorkspace(cwd, { allowWrites: options.allowWrites }),
    ...(modernPolicy && extensions !== undefined ? {
      authorizeToolCall: (name: string, args: unknown, signal?: AbortSignal) =>
        extensions.registeredTools.some((entry) => entry.tool.name === name)
          ? config.permissionPolicy!.authorizeExtension(name, args, signal)
          : Promise.resolve(true),
    } : {}),
    streaming: options.stream,
    contextManager,
    projectInstructions: new ScopedProjectInstructions(cwd, Math.min(16_384, options.contextWindow)),
  };
  return new AgentSession({
    agent,
    cwd,
    resumed: restored.resumed,
    ...(restored.id === undefined ? {} : { id: restored.id }),
    ...(restored.messages === undefined ? {} : { messages: restored.messages }),
    ...(options.compaction && restored.compaction !== undefined ? { compaction: restored.compaction } : {}),
    ...(restored.promptCount === undefined ? {} : { promptCount: restored.promptCount }),
    ...(restored.usage === undefined ? {} : { usage: restored.usage }),
    ...(restored.title === undefined ? {} : { title: restored.title }),
    planMode: restored.planMode ?? false,
    ...(store === undefined ? {} : { store }),
  });
}
