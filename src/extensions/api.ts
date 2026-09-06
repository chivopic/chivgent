import type { AgentEvent } from "../events.js";
import type { Tool } from "../tools/tool.js";
import type { AgentSession } from "../session.js";

export interface ExtensionCommandContext {
  readonly session: AgentSession;
  readonly write: (text: string) => void;
  /** The arguments after the command name, unparsed. */
  readonly argument: string;
}

export interface ExtensionCommand {
  readonly description: string;
  run(context: ExtensionCommandContext): void | Promise<void>;
}

/**
 * What an extension may do.
 *
 * Four entries, deliberately. The reference harness exposes provider
 * registration, keybindings, overlays and renderers, all of which need a TUI
 * to mean anything; chivgent has none yet, so they are absent rather than
 * stubbed.
 */
export interface ExtensionAPI {
  registerTool(tool: Tool): void;
  registerCommand(name: string, command: ExtensionCommand): void;
  on(type: AgentEvent["type"], handler: (event: AgentEvent) => void): void;
  contributeSystemPrompt(text: string): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface RegisteredCommand extends ExtensionCommand {
  readonly name: string;
  /** Path of the extension that registered it, for /help and diagnostics. */
  readonly source: string;
}

export interface RegisteredTool {
  readonly tool: Tool;
  readonly source: string;
}
