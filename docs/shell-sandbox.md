# Shell safety and approval

New sessions can choose a permission mode with `--permission-mode ask-first|workspace|unrestricted`, then inspect or change it with `/permissions` and view it with `/status`. The selection is process-local and is never restored from a saved session; resuming a session does not restore a previously broader mode.

`ask-first` asks before every file change and shell command. A local interactive rich-TUI launch without legacy capability flags selects this mode; Shift+Tab cycles Plan → Auto mode (`workspace`) → Ask for me (`ask-first`) at the idle inline composer. This selection lasts for the process and is not restored by resuming a saved session. Headless, simple, and remote starts retain the existing read-only default unless a mode or legacy capability flag is selected. See [the in-session behavior](../README.md#a-session-you-can-come-back-to).

`workspace` automatically allows workspace file changes and shell commands within the sandbox, with network disabled. A shell request that needs outbound network access can request `scope: "network"` with a justification; when approved, outbound network is enabled within the workspace sandbox without host filesystem access. A shell request that needs host file access must explicitly set `scope: "host"` and give a justification; the approval describes broad host file and network access and applies to that command only (host access is unavailable and fails closed on the Docker backend). Declining, cancellation, or unavailable interactive approval prevents execution. `unrestricted` is an explicit opt-in that runs shell commands automatically with broad host file access and network, within the OS sandbox; direct file tools remain workspace-bound.

The rich TUI preserves command spaces and marks source newlines with `│` and display wraps with `↳`. Commands containing terminal control characters or commands that exceed the display limit are denied before approval; the tool reports that the command cannot be safely displayed for approval. The prompt does not offer approval for those commands. Any column-width change while approval is pending invalidates that preview, even if the terminal is resized back to its original width; request the command again to review it. See [the in-session behavior](../README.md#a-session-you-can-come-back-to).

`--permission-mode` cannot be combined with legacy capability switches such as `--allow-writes` or `--allow-shell`. Existing legacy behavior remains available when no permission mode is selected.

Scope availability follows the session configuration. Legacy flag sessions expose only `workspace`; `--shell-network` controls network access for every command in that session. Per-command `network` and `host` scopes are available only with a modern `--permission-mode` policy.

`--allow-shell` exposes a command runner, but commands still require approval.
Interactive runs ask before every command; headless and socket-server runs deny
commands unless `--approve-all-shell` was explicitly supplied.

## Reading truncated command output

When a bash result is truncated, it includes a session-local `Output ID` and a saved state. Use `read_shell_output` with that ID and a line range to inspect earlier output; it accepts no file path. Reads are limited to 200 lines, 32 KiB returned text, and 5 MiB scanned per request. The output is sanitized before it reaches the transcript. A saved state of `incomplete` means a storage cap was reached; `unavailable` means the spill could not be saved or the reference expired. Per-output storage is capped at 5 MiB and a session at 20 MiB or 20 outputs. IDs expire after one hour of inactivity and are removed on `/clear`, session replacement, and process exit. A resumed transcript cannot restore the in-memory mapping, so old IDs return unavailable. Saving or reading shell output does not widen `read_file`'s workspace boundary or grant shell access.

## Backend selection

`--shell-backend auto|native|docker` selects the executor. `auto` uses the
macOS Seatbelt sandbox on macOS and Docker on other supported platforms. An
explicit backend that is unavailable fails closed; there is no unsandboxed
fallback. The shell tool reports which backend and network setting ran the
command.

The default policy denies network access and writes to the workspace. Add
`--allow-writes` to enable workspace writes (this also enables existing direct
write tools). Add `--shell-network` only when shell commands need network
access. Protected workspace paths include `.git`, `.agents`, `.codex`, `.aws`,
and `.ssh`. Direct workspace write tools reject those paths and symlink escapes.

## macOS Seatbelt

Native mode uses `/usr/bin/sandbox-exec` to apply an OS-enforced profile and
launches `/bin/bash` without startup files. It keeps the host toolchain
available, uses a fresh temporary home for each command, and passes only a
small non-secret environment (PATH, locale and terminal settings). Provider
keys and proxy variables are not passed through. The profile starts with broad
read permission, then denies sensitive roots including user home directories,
`/Users`, `/Volumes`, `/Applications`, and temporary/private data paths before
allowing back the workspace and selected system/toolchain roots. This
deny-then-allow policy is a practical boundary, not a complete filesystem
allowlist; system paths explicitly reopened remain readable. Workspace `.aws`,
`.ssh`, `.codex`, and selected root `.env` filenames (`.env`, `.env.local`,
`.env.development`, `.env.test`, `.env.production`, and `.env.staging`) remain
denied, including through symlinks. Network scope (`scope: "network"`) enables outbound network access while retaining the same practical filesystem restrictions: user home directories, `/tmp`, and secrets remain denied. Host scope removes workspace read/write boundaries for one command but still retains protected OS write paths. macOS Seatbelt behavior depends on OS policy support; an unavailable sandbox executable or failed sandbox launch is an error.
The private home is deleted after each command, so package caches and shell
configuration do not persist between commands.

## Docker

Docker uses a read-only container root, drops Linux capabilities, disables
networking by default, and mounts only the workspace. The workspace mount is
read-only unless `--allow-writes` is set. In write-enabled mode, protected paths
already present at launch are mounted read-only; absent paths are masked with a
small read-only temporary filesystem. This prevents shell commands from
creating protected paths during the run. Docker mode fails closed when a
protected entry is a symlink or `.git` pointer file.
Network scope (`scope: "network"`) enables container bridge networking while retaining workspace mounts and path protections. Docker does not support host filesystem access; requests for `scope: "host"` fail closed with an explicit explanation without executing commands on the host.
Docker is a separate development environment, so host-only tools may not be
present. Docker daemon or image errors fail the command without running it on
the host.

Docker and Seatbelt are boundaries with practical limits, not proof against
kernel or runtime vulnerabilities. Shell commands are powerful within the
access they receive. Use disposable workspaces for untrusted projects and do
not expose sensitive files to shell-readable paths.

```bash
chivgent --permission-mode ask-first "Review this project"
chivgent --permission-mode workspace "Run tests and fix the failure"
chivgent --permission-mode unrestricted "Work across the host and use network"
chivgent --allow-shell                         # interactive; approve each command
chivgent --allow-shell --approve-all-shell "Run tests" # headless; pre-approve every command
chivgent --allow-shell --allow-writes --shell-network --approve-all-shell "Install dependencies"
chivgent --allow-shell --shell-backend docker   # force Docker
```
