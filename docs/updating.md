# Updating chivgent

[中文](updating.zh-CN.md)

If chivgent is installed globally with npm, run:

```sh
chivgent update --check
chivgent update
```

`--check` shows the current version and the npm latest version without installing.
`update` installs a newer version when one is available. It exits when already
current, and never downgrades when the current version is newer than npm's latest.
Restart chivgent after updating. The command needs no API key, starts no model
session and loads no project extensions.

Older releases do not have the `update` command. Upgrade once with:

```sh
npm install -g chivgent@latest
chivgent --version
```

Updates run only when you ask; normal startup never checks for or installs
updates. This is not an in-session `/update` command; run it from your terminal
shell. To send the word `update` to the model as a question, use
`chivgent -- update`. Multiword questions can still be quoted as a whole, such as
`chivgent "update this function"`.

## Installation types

| Installation | Behavior |
| --- | --- |
| Active npm global installation | Checks and updates the same global directory |
| Source checkout, `npm link` | Suggests `git pull --ff-only`, `npm ci` and `npm run build` in the checkout; reinstall if needed |
| Temporary `npx` run | Suggests `npx chivgent@latest` |
| Project-local dependency | Suggests `npm install chivgent@latest` in that project |
| Another package manager or Node environment | Suggests updating with that package manager or environment |

The command never updates source checkouts, temporary installations or local
dependencies automatically, and `--check` only gives guidance for them. If a
source update hits local changes or diverged branches, resolve the Git message
first; the update command never modifies a source repository.

## When an update fails

On failure the command exits non-zero and shows the cause and a manual update
command. If npm is missing, fix the Node/npm installation first. For network
errors, check your network and npm registry configuration. For permission errors,
check that the current npm global directory is writable. chivgent never uses sudo
and never switches to a different global directory.

If the new version needs a newer Node.js, upgrade Node.js and retry. Installation
also enables npm's `engine-strict` check so that dependencies the current Node
cannot run are not installed. Version checks have a timeout, and installation
waits at most five minutes. After a failure or timeout, confirm the actual version
with `chivgent --version` and retry.

On Windows the updater uses the npm JS entry point bundled with the Node
installation; custom installations without it fail with a manual update command.
macOS and Linux use the npm on your PATH. If the current environment's npm global
directory differs from the one chivgent was installed into, the command only
gives guidance.

The implementation relies on npm's
[global prefix/root](https://docs.npmjs.com/cli/v11/commands/npm-root/),
[version lookup](https://docs.npmjs.com/cli/v11/commands/npm-view/) and
[install command](https://docs.npmjs.com/cli/v11/commands/npm-install/), follows
your npm registry configuration, and pins the install to the version it just
checked.
