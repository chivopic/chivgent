# Shell safety and approval

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
keys and proxy variables are not passed through. The profile permits reads
from the host, so commands can inspect files your account can read and can
print their contents to the model. This is write/network containment, not
confidentiality isolation. macOS Seatbelt behavior depends on OS policy support;
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
chivgent --allow-shell                         # interactive; approve each command
chivgent --allow-shell --approve-all-shell "Run tests" # headless; pre-approve every command
chivgent --allow-shell --allow-writes --shell-network --approve-all-shell "Install dependencies"
chivgent --allow-shell --shell-backend docker   # force Docker
```
