import type { AgentEvent } from "../events.js";
import type { Tool } from "../tools/tool.js";
import type {
  ExtensionAPI,
  ExtensionCommand,
  RegisteredCommand,
  RegisteredTool,
} from "./api.js";

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export interface RegistryOptions {
  /** Names an extension may not take, so a project cannot shadow read_file. */
  readonly reservedToolNames: readonly string[];
  readonly reservedCommandNames: readonly string[];
  readonly onWarning: (message: string) => void;
}

/**
 * Collects what extensions register.
 *
 * Every rejection is reported and survivable: a conflicting registration is
 * dropped, the rest of the extension keeps whatever it registered before and
 * after, and the built-in stays in place.
 */
export class ExtensionRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly listeners: {
    readonly type: AgentEvent["type"];
    readonly handler: (event: AgentEvent) => void;
  }[] = [];
  private readonly promptContributions: string[] = [];

  constructor(private readonly options: RegistryOptions) {}

  /** The API handed to one extension; `source` identifies it in diagnostics. */
  apiFor(source: string): ExtensionAPI {
    return {
      registerTool: (tool: Tool) => this.addTool(tool, source),
      registerCommand: (name: string, command: ExtensionCommand) =>
        this.addCommand(name, command, source),
      on: (type, handler) => this.addListener(type, handler, source),
      contributeSystemPrompt: (text: string) =>
        this.addPrompt(text, source),
    };
  }

  get registeredTools(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  get registeredCommands(): readonly RegisteredCommand[] {
    return [...this.commands.values()];
  }

  get systemPromptContributions(): readonly string[] {
    return this.promptContributions;
  }

  command(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  /** A single listener that fans one event out to every subscribed handler. */
  get eventListener(): (event: AgentEvent) => void {
    return (event: AgentEvent): void => {
      for (const listener of this.listeners) {
        if (listener.type !== event.type) {
          continue;
        }
        try {
          listener.handler(event);
        } catch {
          // An extension must not change the outcome of the run it observes.
        }
      }
    };
  }

  private addTool(tool: Tool, source: string): void {
    if (
      typeof tool !== "object" ||
      tool === null ||
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      typeof tool.execute !== "function"
    ) {
      this.options.onWarning(`${source}: registerTool needs a tool with a name and an execute function.`);
      return;
    }
    if (this.options.reservedToolNames.includes(tool.name)) {
      this.options.onWarning(
        `${source}: cannot register the tool "${tool.name}"; that name is built in.`,
      );
      return;
    }
    const existing = this.tools.get(tool.name);
    if (existing !== undefined) {
      this.options.onWarning(
        `${source}: the tool "${tool.name}" is already registered by ${existing.source}.`,
      );
      return;
    }
    this.tools.set(tool.name, { tool, source });
  }

  private addCommand(
    name: string,
    command: ExtensionCommand,
    source: string,
  ): void {
    if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
      this.options.onWarning(
        `${source}: "${String(name)}" is not a usable command name; use lowercase letters, digits and dashes.`,
      );
      return;
    }
    if (typeof command !== "object" || command === null || typeof command.run !== "function") {
      this.options.onWarning(`${source}: the command "${name}" needs a run function.`);
      return;
    }
    if (this.options.reservedCommandNames.includes(name)) {
      this.options.onWarning(
        `${source}: cannot register "/${name}"; that command is built in.`,
      );
      return;
    }
    const existing = this.commands.get(name);
    if (existing !== undefined) {
      this.options.onWarning(
        `${source}: "/${name}" is already registered by ${existing.source}.`,
      );
      return;
    }
    this.commands.set(name, {
      name,
      source,
      description: typeof command.description === "string" ? command.description : "",
      run: command.run.bind(command),
    });
  }

  private addListener(
    type: AgentEvent["type"],
    handler: (event: AgentEvent) => void,
    source: string,
  ): void {
    if (typeof handler !== "function") {
      this.options.onWarning(`${source}: on("${String(type)}") needs a function.`);
      return;
    }
    this.listeners.push({ type, handler });
  }

  private addPrompt(text: string, source: string): void {
    if (typeof text !== "string" || text.trim().length === 0) {
      this.options.onWarning(`${source}: contributeSystemPrompt needs a non-empty string.`);
      return;
    }
    this.promptContributions.push(text.trim());
  }
}
