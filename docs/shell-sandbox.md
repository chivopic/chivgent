# Shell safety and approval

New sessions can choose a permission mode with `--permission-mode ask-first|workspace|unrestricted`, then inspect or change it with `/permissions` and view it with `/status`. The selection is process-local and is never restored from a saved session; resuming a session does not restore a previously broader mode.

`ask-first` asks before every file change and shell command. `workspace` automatically allows workspace file changes and shell commands within the sandbox, with network disabled. A shell request that needs host file access must explicitly set `scope: "host"` and give a justification; the approval describes broad host file access and applies to that command only. Declining, cancellation, or unavailable interactive approval prevents execution. Host scope does not enable network. `unrestricted` is an explicit opt-in that runs shell commands automatically with broad host file access and network, within the OS sandbox; direct file tools remain workspace-bound.

`--permission-mode` cannot be combined with legacy capability switches such as `--allow-writes` or `--allow-shell`. Existing legacy behavior remains available when no permission mode is selected.

`--allow-shell` exposes a command runner, but commands still require approval.
Interactive runs ask before every command; headless and socket-server runs deny
commands unless `--approve-all-shell` was explicitly supplied.

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
`.ssh`, `.codex`, and root `.env*` files remain denied, including through
symlinks. Host scope removes workspace read/write boundaries for one command
but still retains protected OS write paths. macOS Seatbelt behavior depends on OS policy support;
an unavailable sandbox executable or failed sandbox launch is an error.
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
