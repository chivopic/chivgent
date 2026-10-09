# Shell safety and approval (P0-C)

The `bash` tool runs **inside a Docker container**, not a shell on the host. Enabling the tool with `--allow-shell` does not automatically authorize each command.

## Modes

- Normal interactive use: `chivgent --allow-shell`. Before *each* model-produced command, chivgent displays its literal command and asks `Approve? [y/N]`. Only the exact reply `y` approves. The default is deny.
- Non-interactive or socket-server use: shell commands are **denied** unless `--approve-all-shell` is also provided. This option explicitly approves all shell commands for this process; it is a high-trust choice, not a sandbox escape.
- `--approve-all-shell` without `--allow-shell` is an error.
- Docker is required, including on macOS. If the Docker CLI/daemon is unavailable, commands fail. **There is no fallback to host execution**. Ensure the `node:22-alpine` image is available ahead of time if your Docker daemon cannot download it.

## What isolation enforces

Each command starts a new container with:

- `--network none`: no container network access.
- One bind mount: the project working directory at `/workspace`, writable by the user's UID.
- Read-only container root filesystem and a size-limited temporary `/tmp`.
- Dropped Linux capabilities, no-new-privileges, PID/CPU/memory limits, and a non-root UID/GID.
- No host home, Docker socket or API keys passed into the container.
- A unique container name; the CLI force-removes it after completion, error, abort and timeout.

Execution is still powerful **inside the project**: shell commands can delete files there or print project secrets to the model. Docker isolation is not proof against vulnerabilities in Docker, kernel features or the VM, and this mechanism does not isolate `write_file`, `edit_file`, or explicitly trusted extension JavaScript. The project is mounted read-write when bash is enabled; do not use this mode on untrusted repositories containing valuable files or credentials. Work on disposable copies and keep sensitive directories outside the workspace.

A Docker image is a development environment, not the host macOS environment. Some host-only tools will be unavailable. CI tests assert the construction of security flags and use explicit fake/local shell runners; **the CI does not prove actual Docker isolation on macOS**. Run a manual end-to-end smoke test on your machine with Docker Desktop before relying on it.

## Example

```bash
docker pull node:22-alpine
chivgent --allow-shell
# When a command appears, type y to allow or n/Enter to deny.
```

```bash
# Headless automation, explicitly pre-authorized inside Docker:
chivgent --allow-shell --approve-all-shell "Run the project tests"
```

Never pass `--approve-all-shell` just to suppress prompts for an unknown codebase. Eval tasks requesting shell deliberately approve execution because they run in disposable fixtures; the Docker container boundary still applies.
