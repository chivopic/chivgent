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
import { MODERN_SHELL_SYSTEM_PROMPT, modernPermissionPrompt, modelSelectionPrompt, type ModelSelection, SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT, WEB_SEARCH_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT } from "./prompts.js";
import { AgentSession } from "./session.js";
import { ShellApprovalGate } from "./shell/approval.js";
import { PermissionWorkspace, type PermissionPolicy, type ShellScope } from "./permissions.js";
import { createShellOperations } from "./shell/factory.js";
import type { SessionStore } from "./session-store.js";
import { BashTool } from "./tools/bash.js";
import { ReadShellOutputTool } from "./tools/read-shell-output.js";
import { ShellOutputStore } from "./shell/output-store.js";
import { ApplyPatchTool } from "./tools/apply-patch.js";
import { EditFileTool } from "./tools/edit-file.js";
import { ListFilesTool } from "./tools/list-files.js";
import { ReadFileTool } from "./tools/read-file.js";
import { SearchTextTool } from "./tools/search-text.js";
import { WebSearchTool } from "./tools/web-search.js";
import { WriteFileTool } from "./tools/write-file.js";
import { UpdatePlanTool } from "./tools/update-plan.js";
import { QuestionTool } from "./tools/question.js";
import { QuestionBroker } from "./questions.js";
import { DEEPSEEK_SEARCH_QUERY_CHARACTERS, SearxngBackend, type WebSearchBackend } from "./websearch/backend.js";
import { LocalWorkspace } from "./workspace.js";

interface LocalSessionConfig {
  readonly options: CliOptions;
  readonly cwd: string;
  readonly llm: LLMClient;
  readonly modelSelection?: () => ModelSelection;
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
  readonly webSearchBackend?: WebSearchBackend;
  readonly automaticWebSearch?: () => WebSearchBackend | undefined;
  readonly allowShellForPolicy?: boolean;
}

/** Assemble the local agent once; cli.ts handles only process and UI lifecycle. */
export function createLocalSession(config: LocalSessionConfig): AgentSession {
  const { options, cwd, llm, extensions, restored, store } = config;
  const prompt = [SYSTEM_PROMPT];
  const modernPolicy = config.permissionPolicy !== undefined;
  const allowWrites = modernPolicy || options.allowWrites;
  const allowShell = modernPolicy ? (config.allowShellForPolicy ?? true) : options.allowShell;
  const shellOutputStore = allowShell ? new ShellOutputStore() : undefined;
  const webSearchBackend = config.webSearchBackend ?? (options.webSearch === undefined || !("url" in options.webSearch)
    ? undefined
    : new SearxngBackend({
        baseURL: options.webSearch.url,
        ...(options.webSearch.token === undefined ? {} : { token: options.webSearch.token }),
      }));
  if (allowWrites) prompt.push(WRITE_SYSTEM_PROMPT);
  if (allowShell) prompt.push(modernPolicy ? MODERN_SHELL_SYSTEM_PROMPT : SHELL_SYSTEM_PROMPT);
  let webSearchTool: WebSearchTool | undefined;
  if (webSearchBackend !== undefined) {
    const policy = config.permissionPolicy;
    webSearchTool = new WebSearchTool({
      backend: webSearchBackend,
      ...(policy !== undefined && options.webSearch?.approved !== true ? {
        authorize: (query, signal) => policy.authorizeWebSearch(query, webSearchBackend.name, signal),
      } : {}),
    });
  } else if (config.automaticWebSearch !== undefined) {
    webSearchTool = new WebSearchTool({
      backend: config.automaticWebSearch,
      queryCharacters: DEEPSEEK_SEARCH_QUERY_CHARACTERS,
    });
  }
  if (modernPolicy) prompt.push(modernPermissionPrompt());
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

  let webSearchDatePrompt: string | undefined;
  const agent: Omit<AgentOptions, "onEvent"> = {
    systemPrompt: () => [
      ...prompt,
      ...(webSearchTool?.isAvailable() ? [
        WEB_SEARCH_SYSTEM_PROMPT,
        ...(webSearchDatePrompt === undefined ? [] : [webSearchDatePrompt]),
      ] : []),
      modelSelectionPrompt(config.modelSelection?.() ?? options),
    ].join("\n"),
    maxTurns: options.maxTurns,
    llm,
    tools: [
      new ListFilesTool(),
      new SearchTextTool(),
      ...(webSearchTool === undefined ? [] : [webSearchTool]),
      new ReadFileTool(),
      new UpdatePlanTool(),
      new QuestionTool(new QuestionBroker()),
      ...(allowWrites ? [new WriteFileTool(), new EditFileTool(), new ApplyPatchTool()] : []),
      ...(allowShell ? [new BashTool({
        cwd,
        outputStore: shellOutputStore!,
        allowWrites,
        allowNetwork: modernPolicy ? config.permissionPolicy!.shellNetwork : options.shellNetwork,
        backend: options.shellBackend,
        ...(modernPolicy ? {
          operationsForCall: (scope: ShellScope = "workspace") => createShellOperations({
            backend: options.shellBackend,
            allowWrites: true,
            allowNetwork: scope === "network" || scope === "host" || config.permissionPolicy!.shellNetwork,
            allowHostAccess: scope === "host",
          }),
          supportedScopes: ["workspace", "network", "host"],
          defaultScopeForCall: () => config.permissionPolicy!.mode === "unrestricted" ? "host" as const : "workspace" as const,
          authorize: (request) => config.permissionPolicy!.authorizeShell(
            request.command,
            request.scope,
            request.signal,
            request.justification ? `Reason requested by model: ${request.justification}` : undefined,
          ),
        } : {
          approve: (command, signal, context) => config.shellApproval?.approveDecision(command, signal, context) ?? Promise.resolve({ approved: false, reason: "unavailable" }),
        }),
      }), new ReadShellOutputTool(shellOutputStore!)] : []),
      ...(extensions?.registeredTools ?? []).map((entry) => entry.tool),
    ],
    workspace: modernPolicy ? new PermissionWorkspace(cwd, config.permissionPolicy!) : new LocalWorkspace(cwd, { allowWrites: options.allowWrites }),
    ...(shellOutputStore === undefined ? {} : {
      clearSessionData: () => shellOutputStore.clear(),
      closeSessionData: () => shellOutputStore.close(),
    }),
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
  const session = new AgentSession({
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
  if (webSearchTool !== undefined) {
    session.subscribe((event) => {
      if (event.type === "agent_start") {
        // Keep the provider prompt stable through tool calls, even at midnight.
        webSearchDatePrompt = `Current date (UTC): ${new Date().toISOString().slice(0, 10)}`;
      }
    });
  }
  return session;
}
