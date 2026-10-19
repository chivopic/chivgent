# chivgent 1.1.2

This release improves Provider sign-in and the terminal conversation view. It
also introduces the desktop app in the README as an in-development preview.

## Terminal improvements

- `/login` first asks which Provider to configure, then prompts for its API key
  with hidden input. `/login NAME` still goes directly to that Provider. Cancelling
  the selection leaves the active Provider and saved credentials unchanged.
- Scrolling up over the transcript hands the mouse wheel back to the terminal's
  native scrollback. The next key resumes composer mouse tracking without
  changing the draft. Slash-menu and multi-line draft scrolling keep their
  existing behavior.
- The welcome view gives the workspace path its own line. The idle composer
  footer shows the active Provider and model beside the mode hint, keeping that
  hint visible in narrow windows. A missing model is not given a placeholder name.

See the [TUI guide](tui.md) for controls and configuration.

## Desktop — Coming soon

The desktop app remains in active development. Recent work adds a cleaner project
workspace, an ivory-background app icon, and per-project read-only conversation
recovery after refresh or restart. Interrupted runs are shown without automatically
replaying model requests or tools. The README now includes a workspace preview,
and [product media](../product-media/README.md) is available for the product site.

This npm release distributes the CLI; it does not ship a desktop installer.
See the [desktop architecture and current limits](desktop-architecture.md) for
supported capabilities and remaining work.

## Upgrade after publication

```sh
chivgent update --check
chivgent update
```

Or install the version explicitly with `npm install -g chivgent@1.1.2` after it
has been published. Node.js 22 or newer is required.

## Release preparation

The release gate is `npm run release:check`, which runs type checking, tests, a
production build, and an npm package dry run. Follow the [release workflow](releasing.md)
to publish from `main` after the preparation PR is merged. That workflow creates
the matching tag and GitHub release only after npm publication succeeds.
