import { LocalWorkspace } from "./workspace.js";
import type { Workspace } from "./workspace.js";
import type { EditTextFileOptions, EditTextFileResult, ListFilesOptions, ListFilesResult, PatchResult, ReadTextFileOptions, SearchTextOptions, SearchTextResult, TextFileSlice, WriteTextFileResult } from "./workspace/types.js";
import { WorkspaceError } from "./workspace/types.js";

export const PERMISSION_MODES = ["ask-first", "workspace", "unrestricted"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export type ShellScope = "workspace" | "host";
export type PermissionApproval = (action: string, signal?: AbortSignal, context?: string) => Promise<boolean>;

/** Approval context prefix the REPL uses to render a full-query web prompt. */
export const WEB_SEARCH_APPROVAL_PREFIX = "Web search via ";

/** Selects the policy for one interactive process; saved sessions never supply it. */
export function initialPermissionMode(options: {
  readonly interactive: boolean;
  readonly tui: boolean;
  readonly permissionMode?: PermissionMode;
  readonly allowWrites: boolean;
  readonly allowShell: boolean;
  readonly approveAllShell: boolean;
  readonly shellNetwork: boolean;
}): PermissionMode | undefined {
  if (options.permissionMode !== undefined) return options.permissionMode;
  if (!options.interactive || !options.tui || options.allowWrites || options.allowShell || options.approveAllShell || options.shellNetwork) return undefined;
  return "ask-first";
}

/** Session-process policy. It is deliberately not restored from transcript data. */
export class PermissionPolicy {
  private modeValue: PermissionMode;
  private approval: PermissionApproval | undefined;

  constructor(mode: PermissionMode, approval?: PermissionApproval) {
    this.modeValue = mode;
    this.approval = approval;
  }

  get mode(): PermissionMode { return this.modeValue; }
  setMode(mode: PermissionMode): void { this.modeValue = mode; }
  setApproval(approval: PermissionApproval | undefined): void { this.approval = approval; }

  async authorizeWrite(action: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.modeValue !== "ask-first") return true;
    const approved = await (this.approval?.(action, signal, "File change") ?? Promise.resolve(false));
    return approved && signal?.aborted !== true;
  }

  async authorizeShell(command: string, scope: ShellScope, signal?: AbortSignal, context?: string): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.modeValue === "unrestricted") return true;
    if (this.modeValue === "workspace" && scope === "workspace") return true;
    const scopeContext = scope === "host" ? "Expanded host access for this command only: shell may read/write outside the workspace and use network (protected OS write paths still apply)" : context;
    const approved = await (this.approval?.(command, signal, scopeContext) ?? Promise.resolve(false));
    return approved && signal?.aborted !== true;
  }

  async authorizeExtension(toolName: string, argumentsValue: unknown, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.modeValue === "unrestricted") return true;
    const preview = JSON.stringify(argumentsValue);
    const approved = await (this.approval?.(preview, signal, `Extension tool ${toolName}`) ?? Promise.resolve(false));
    return approved && signal?.aborted !== true;
  }

  /** Network access leaves the machine, so ask-first and workspace ask each time. */
  async authorizeWebSearch(query: string, provider: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.modeValue === "unrestricted") return true;
    const approved = await (this.approval?.(
      query,
      signal,
      `${WEB_SEARCH_APPROVAL_PREFIX}${provider}`,
    ) ?? Promise.resolve(false));
    return approved && signal?.aborted !== true;
  }

  get shellNetwork(): boolean { return this.modeValue === "unrestricted"; }
}

/** Workspace writes pass through the active policy immediately before mutation. */
export class PermissionWorkspace implements Workspace {
  private readonly base: Workspace;
  readonly root: string;

  constructor(root: string, private readonly policy: PermissionPolicy) {
    this.base = new LocalWorkspace(root, { allowWrites: true });
    this.root = this.base.root;
  }

  readTextFile(path: string, options?: ReadTextFileOptions): Promise<TextFileSlice> { return this.base.readTextFile(path, options); }
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult> { return this.base.listFiles(options); }
  searchText(options: SearchTextOptions): Promise<SearchTextResult> { return this.base.searchText(options); }

  async writeTextFile(path: string, contents: string, signal?: AbortSignal): Promise<WriteTextFileResult> {
    if (!(await this.policy.authorizeWrite(`Create or replace ${path}`, signal)) || signal?.aborted) throw deniedWrite();
    return this.base.writeTextFile(path, contents, signal);
  }

  async editTextFile(path: string, options: EditTextFileOptions, signal?: AbortSignal): Promise<EditTextFileResult> {
    if (!(await this.policy.authorizeWrite(`Edit ${path}`, signal)) || signal?.aborted) throw deniedWrite();
    return this.base.editTextFile(path, options, signal);
  }

  async applyPatch(patch: string, signal?: AbortSignal): Promise<PatchResult> {
    if (!(await this.policy.authorizeWrite("Apply patch to workspace", signal)) || signal?.aborted) throw deniedWrite();
    return this.base.applyPatch!(patch, signal);
  }
}

function deniedWrite(): WorkspaceError {
  return new WorkspaceError("writes_disabled", "File change denied: approval was declined or unavailable.");
}

export function parsePermissionMode(value: string): PermissionMode {
  if ((PERMISSION_MODES as readonly string[]).includes(value)) return value as PermissionMode;
  throw new TypeError(`--permission-mode must be one of ${PERMISSION_MODES.join(", ")}.`);
}

export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case "ask-first": return "File changes, every shell command, and every configured web search require approval; no approval means no action.";
    case "workspace": return "Workspace file changes and sandboxed shell commands run automatically; network, expanded host access, and configured web search require approval.";
    case "unrestricted": return "Shell commands run automatically with broad host file access and network inside the OS sandbox; configured web search runs without a prompt; workspace file tools remain workspace-bound.";
  }
}
