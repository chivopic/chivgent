# chivgent 0.19.0

This release adds an explicit update command for npm global installations.

```sh
chivgent update --check
chivgent update
```

`--check` reports available updates without installing. `update` installs a newer
version into the matching npm global prefix and verifies the installed version.
Restart chivgent afterwards. Already-current and newer-than-latest installations
are left alone; unsupported Node.js requirements are reported before installing.

The command runs before provider configuration, sessions and project extensions,
so it needs no API key. Updates are only checked when requested. Source checkouts,
linked packages, local dependencies and temporary npx installations receive
manual instructions instead of being replaced.

Failures report the cause and a manual update command. The updater uses npm's
configured registry, pins the checked version, enforces engine compatibility,
and does not elevate privileges. See [the updating guide](updating.md).

## Upgrade from an older release

Versions before 0.19.0 do not contain the update command. Upgrade once with:

```sh
npm install -g chivgent@latest
chivgent --version
```

Node.js 22 or newer is required. To ask the agent about the literal word
`update`, use `chivgent -- update`; quoted multiword questions continue to work.

## Validation

- All 492 automated tests, type checking, build and package dry run passed.
- Update and CLI regressions passed on Node 22 and Node 24.
- The packaged CLI completed a real npm upgrade in an isolated global prefix
  against a local fixture registry, including a check-only run and verification
  of the replacement executable. No production installation was modified.
- Windows-specific npm invocation has not been tested on a Windows host.
