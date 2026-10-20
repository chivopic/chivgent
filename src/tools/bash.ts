import type { Tool, ToolContext, ToolOutput } from "./tool.js";
import { validateTimeoutSeconds } from "../shell/local.js";
import { createShellOperations, type ShellBackend } from "../shell/factory.js";
import type { ShellApproval } from "../shell/approval.js";
import type { ShellScope } from "../permissions.js";
import { OutputAccumulator } from "../shell/output.js";
import { formatSize, type TruncationResult } from "../shell/truncate.js";
import {
  ShellAbortError,
  ShellTimeoutError,
  ShellUnavailableError,
  type ShellOperations,
} from "../shell/types.js";

/** How often a running command may push an output snapshot. */
export const OUTPUT_UPDATE_THROTTLE_MS = 100;

function createInputSchema(scopes: readonly ShellScope[]): Readonly<Record<string, unknown>> {
  const scopeDescriptions: Record<ShellScope, string> = {
    workspace: "Sandboxed workspace command (network disabled unless enabled by the active policy).",
    network: "Sandboxed workspace command with outbound network access.",
    host: "Command with broad host file and network access.",
  };
  const elevatedScopes = scopes.filter(scope => scope !== "workspace");
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command to run in the workspace root. Not interactive: it has no stdin.",
      },
      timeout: {
        type: "number",
        description:
          "Optional timeout in seconds. There is no default; set one for commands that may hang.",
      },
      scope: {
        type: "string",
        enum: [...scopes],
        description: `Permission scope: ${scopes.map(scope => `'${scope}' (${scopeDescriptions[scope]})`).join(", ")}.`,
      },
      justification: {
        type: "string",
        description: elevatedScopes.length === 0
          ? "This shell does not support elevated scopes."
          : `Required explanation when explicitly setting scope to ${elevatedScopes.map(scope => `'${scope}'`).join(" or ")}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

interface BashArguments {
  readonly command: string;
  readonly timeoutSeconds?: number;
  readonly scope?: ShellScope;
  readonly justification?: string;
}

export interface ShellAuthorizeRequest {
  readonly command: string;
  readonly scope: ShellScope;
  readonly justification?: string;
  readonly backend?: string;
  readonly signal?: AbortSignal;
}
export type ShellAuthorize = (request: ShellAuthorizeRequest) => Promise<boolean>;

export interface BashToolOptions {
  readonly cwd: string;
  readonly allowWrites?: boolean;
  readonly allowNetwork?: boolean;
  readonly backend?: ShellBackend;
  /** Swap in a container or SSH backend without touching the tool. */
  readonly operations?: ShellOperations;
  /** Rebuild the sandbox from the active permission mode for each call. */
  readonly operationsForCall?: (scope?: ShellScope) => ShellOperations;
  /** Scopes the configured executor can honor. Defaults to workspace only. */
  readonly supportedScopes?: readonly ShellScope[];
  readonly defaultScopeForCall?: () => ShellScope;
  /** Direct typed authorization callback. */
  readonly authorize?: ShellAuthorize;
  /** A human decision (or explicit session-wide approval). Absent means deny. */
  readonly approve?: ShellApproval;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly tempDirectory?: string;
  readonly throttleMs?: number;
}

export class BashTool implements Tool {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the workspace root and return its combined stdout and stderr. Output is truncated to the last part of the run; the full output is written to a temp file when that happens. Not interactive: commands get no stdin.";
  readonly inputSchema: Readonly<Record<string, unknown>>;

  private readonly cwd: string;
  private readonly operations: ShellOperations;
  private readonly operationsForCall: ((scope?: ShellScope) => ShellOperations) | undefined;
  private readonly supportedScopes: readonly ShellScope[];
  private readonly defaultScopeForCall: (() => ShellScope) | undefined;
  private readonly authorize: ShellAuthorize | undefined;
  private readonly approve: ShellApproval | undefined;
  private readonly maxLines?: number;
  private readonly maxBytes?: number;
  private readonly tempDirectory?: string;
  private readonly throttleMs: number;

  constructor(options: BashToolOptions) {
    this.cwd = options.cwd;
    this.operations = options.operations ?? createShellOperations({ backend: options.backend, allowWrites: options.allowWrites, allowNetwork: options.allowNetwork });
    this.operationsForCall = options.operationsForCall;
    this.supportedScopes = options.supportedScopes ?? ["workspace"];
    this.inputSchema = createInputSchema(this.supportedScopes);
    this.defaultScopeForCall = options.defaultScopeForCall;
    this.authorize = options.authorize;
    this.approve = options.approve;
    if (options.maxLines !== undefined) {
      this.maxLines = options.maxLines;
    }
    if (options.maxBytes !== undefined) {
      this.maxBytes = options.maxBytes;
    }
    if (options.tempDirectory !== undefined) {
      this.tempDirectory = options.tempDirectory;
    }
    this.throttleMs = options.throttleMs ?? OUTPUT_UPDATE_THROTTLE_MS;
  }

  async execute(
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolOutput> {
    let parsed: BashArguments | undefined;
    try {
      parsed = parseArguments(argumentsValue);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? error.message : "Invalid arguments.",
        isError: true,
      };
    }
    if (parsed === undefined) {
      return {
        content:
          'Invalid arguments. Expected {"command":"npm test","timeout":120} with a non-empty command.',
        isError: true,
      };
    }

    if (context.signal?.aborted) {
      throw new ShellAbortError();
    }
    const scope = parsed.scope ?? this.defaultScopeForCall?.() ?? "workspace";
    if (!this.supportedScopes.includes(scope)) {
      return { content: `Shell scope "${scope}" is unavailable for this shell configuration.`, isError: true };
    }
    if (parsed.scope === "host" && !parsed.justification?.trim()) {
      return { content: 'Host scope requires a non-empty "justification".', isError: true };
    }
    if (parsed.scope === "network" && !parsed.justification?.trim()) {
      return { content: 'Network scope requires a non-empty "justification".', isError: true };
    }
    let operations: ShellOperations;
    try {
      operations = this.operationsForCall?.(scope) ?? this.operations;
    } catch (error: unknown) {
      if (error instanceof ShellUnavailableError) {
        return { content: error.message, isError: true };
      }
      throw error;
    }

    let approved: boolean;
    try {
      if (this.authorize !== undefined) {
        approved = await this.authorize({
          command: parsed.command,
          scope,
          justification: parsed.justification,
          backend: operations.backend,
          signal: context.signal,
        });
      } else if (this.approve !== undefined) {
        const approvalContext = formatApprovalContext(scope, operations.backend, parsed.justification);
        approved = await this.approve(parsed.command, context.signal, approvalContext);
      } else {
        return { content: "Shell command denied: explicit approval is required.", isError: true };
      }
    } catch (error: unknown) {
      if (isAbortError(error) || context.signal?.aborted) throw new ShellAbortError();
      return { content: "Shell command denied: approval failed.", isError: true };
    }
    if (context.signal?.aborted) throw new ShellAbortError();
    if (!approved) {
      return { content: "Shell command denied by user.", isError: true };
    }

    const output = new OutputAccumulator({
      ...(this.maxLines === undefined ? {} : { maxLines: this.maxLines }),
      ...(this.maxBytes === undefined ? {} : { maxBytes: this.maxBytes }),
      ...(this.tempDirectory === undefined
        ? {}
        : { tempDirectory: this.tempDirectory }),
    });
    const publish = createThrottledPublisher(
      output,
      context.onUpdate,
      this.throttleMs,
    );

    try {
      let exitCode: number | null;
      try {
        const result = await operations.exec(parsed.command, this.cwd, {
          onData: (chunk) => {
            output.append(chunk);
            publish.schedule();
          },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(parsed.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: parsed.timeoutSeconds }),
        });
        exitCode = result.exitCode;
      } catch (error: unknown) {
        // An abort ends the whole run, so it propagates; everything else is a
        // tool error that still has to carry whatever the command printed.
        // Either way the spill file is closed by the finally block below.
        if (isAbortError(error)) {
          throw error;
        }
        const text = await this.finish(output, publish, "");
        if (error instanceof ShellTimeoutError) {
          return { content: appendStatus(text, error.message), isError: true };
        }
        if (error instanceof ShellUnavailableError) {
          return { content: appendStatus(text, error.message), isError: true };
        }
        return {
          content: appendStatus(
            text,
            error instanceof Error ? error.message : "Command failed to start",
          ),
          isError: true,
        };
      }

      const text = await this.finish(output, publish, "(no output)");
      if (exitCode !== 0 && exitCode !== null) {
        const isNetworkBlocked = scope === "workspace" && operations.networkAccess === false && NETWORK_FAILURE_PATTERN.test(text);
        const status = isNetworkBlocked
          ? `Command exited with code ${exitCode} (${networkDisabledHint(this.supportedScopes.includes("network"))})`
          : `Command exited with code ${exitCode}`;
        return {
          content: appendStatus(text, status),
          isError: true,
        };
      }
      return { content: text, isError: false };
    } finally {
      publish.cancel();
      // An aborted command still has an open spill file and a decoder holding
      // bytes; leaving them behind leaks a file descriptor per cancelled run.
      output.finish();
      await output.close();
    }
  }

  private async finish(
    output: OutputAccumulator,
    publish: ThrottledPublisher,
    emptyText: string,
  ): Promise<string> {
    output.finish();
    publish.cancel();
    publish.flush();
    const snapshot = output.snapshot();
    return renderOutput(snapshot.content, snapshot.truncation, snapshot.fullOutputPath, emptyText);
  }
}

interface ThrottledPublisher {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

/**
 * Rate-limits output snapshots.
 *
 * A build can print thousands of lines a second; one event per chunk would cost
 * more than the command. Snapshots are sent at most once per interval, and the
 * final result is authoritative anyway.
 */
function createThrottledPublisher(
  output: OutputAccumulator,
  onUpdate: ((content: string) => void) | undefined,
  throttleMs: number,
): ThrottledPublisher {
  if (onUpdate === undefined) {
    return { schedule: () => undefined, flush: () => undefined, cancel: () => undefined };
  }

  let timer: NodeJS.Timeout | undefined;
  let dirty = false;
  let lastPublishedAt = 0;

  const publish = (): void => {
    if (!dirty) {
      return;
    }
    dirty = false;
    lastPublishedAt = Date.now();
    onUpdate(output.snapshot().content);
  };

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule(): void {
      dirty = true;
      const delay = throttleMs - (Date.now() - lastPublishedAt);
      if (delay <= 0) {
        clear();
        publish();
        return;
      }
      timer ??= setTimeout(() => {
        timer = undefined;
        publish();
      }, delay);
    },
    flush(): void {
      clear();
      publish();
    },
    cancel: clear,
  };
}

function renderOutput(
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
  emptyText: string,
): string {
  const text = content.length > 0 ? content : emptyText;
  if (!truncation.truncated) {
    return text;
  }

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const location = truncation.lastLinePartial
    ? `Showing the last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines}`
    : `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`;
  const reason =
    truncation.truncatedBy === "bytes"
      ? ` (${formatSize(truncation.maxBytes)} limit)`
      : "";
  const full =
    fullOutputPath === undefined ? "" : `. Full output: ${fullOutputPath}`;
  return `${text}\n\n[${location}${reason}${full}]`;
}

function appendStatus(text: string, status: string): string {
  return text.length > 0 ? `${text}\n\n${status}` : status;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function parseArguments(value: unknown): BashArguments | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["command", "timeout", "scope", "justification"].includes(key))
  ) {
    return undefined;
  }
  if (typeof record.command !== "string" || record.command.trim().length === 0) {
    return undefined;
  }
  if (record.scope !== undefined && record.scope !== "workspace" && record.scope !== "network" && record.scope !== "host") return undefined;
  if (record.justification !== undefined && (typeof record.justification !== "string" || record.justification.length > 500 || /[\x00-\x1f\x7f]/.test(record.justification))) return undefined;
  if ((record.scope === "host" || record.scope === "network") && (typeof record.justification !== "string" || record.justification.trim().length === 0)) return undefined;
  if (record.timeout !== undefined && typeof record.timeout !== "number") return undefined;
  return {
    command: record.command,
    ...(record.timeout === undefined ? {} : { timeoutSeconds: validateTimeoutSeconds(record.timeout) }),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
    ...(record.justification === undefined ? {} : { justification: record.justification }),
  };
}

function formatApprovalContext(scope: ShellScope, backend?: string, justification?: string): string {
  const reason = justification ? ` Reason: ${justification}` : "";
  const backendNote = backend ? ` (${backend})` : "";
  if (scope === "host") {
    return `Expanded host access for this command only: shell may read/write outside workspace and use network.${reason}${backendNote}`;
  }
  if (scope === "network") {
    return `Network access for this command only: outbound network enabled within workspace sandbox.${reason}${backendNote}`;
  }
  return `Shell context: ${backend ?? "sandboxed workspace; network disabled"}`;
}

function networkDisabledHint(canRequestNetworkScope: boolean): string {
  return canRequestNetworkScope
    ? 'network access is disabled in the active sandbox; if network is needed, request bash with scope "network" and justification'
    : "network access is disabled in the active sandbox; enable shell network access with --shell-network before retrying";
}

export const NETWORK_FAILURE_PATTERN = /(?:ENETUNREACH|Network is unreachable|Could not resolve host|Temporary failure in name resolution|getaddrinfo ENOTFOUND|getaddrinfo EAI_AGAIN|npm error code (?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED))/i;
