<!-- reviewed-through: 15d5264 (2026-10-18) -->
# Lessons from merged work

Read this before changing code. Each lesson is a rule, then why, then the evidence. "Seen" counts the days a review found it. A lesson seen on 3 or more separate days moves into [docs/code-standards.md](docs/code-standards.md).

The shape is copied from [yetone/magpie's LESSONS.md](https://github.com/yetone/magpie/blob/main/LESSONS.md). The incidents are not. Do not paste another project's failures into this file. When a review of merged chivgent work finds a repeated miss, add it here.

## 2026-10-20 — Keep GUI acceptance away from the shared desktop

Seen: 1. This is an agent verification workflow incident, not a finding from a merged pull request review.

Rule: Do not start local GUI acceptance loops by default. GUI entrypoints must refuse a shared desktop unless the user explicitly opts in with `--allow-ui`; batch GUI E2E belongs in Linux CI under Xvfb. A cancellation or interruption of an agent turn does not prove that its OS processes stopped: retain the command/session identity, terminate only processes owned by that run when asked to stop, and verify the owned process tree is gone.

Why: On 2026-10-20, repeated local `verify-readonly.mjs` runs opened visible Electron windows. The issue was the interaction between those test launchers and the app's unconditional window display from `ready-to-show` and activation in [main/index.ts](apps/desktop/src/main/index.ts), while the agent failed to account for the user sharing that desktop. The user asked for the run to stop, then requested guards on all three visible GUI acceptance entrypoints. This was an operational interruption, not a product permission or security-policy defect.

Evidence: The guards in [e2e-ui-guard.mjs](apps/desktop/scripts/e2e-ui-guard.mjs) protect [verify-readonly.mjs](apps/desktop/scripts/verify-readonly.mjs), [verify-history.mjs](apps/desktop/scripts/verify-history.mjs), and [verify-packaged.mjs](apps/desktop/scripts/verify-packaged.mjs). [e2e-ui-guard.test.ts](apps/desktop/tests/e2e-ui-guard.test.ts) checks local refusal before fixture creation; [ci.yml](.github/workflows/ci.yml) runs the repeated path on Linux Xvfb. The guard and unit tests pass locally. CI confirmation of all 20 GUI runs is pending until this branch's workflow completes.
