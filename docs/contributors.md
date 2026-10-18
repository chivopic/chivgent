# What stops a review

This page follows the harm check in [yetone/magpie's contributors notes](https://github.com/yetone/magpie/blob/main/docs/contributors.md). It does not copy that repository's author lists, and it does not copy magpie's decision to refuse community pull requests. This repository takes pull requests. An agent still does not close, approve, or merge one. It writes the evidence and the maintainer decides.

## Look for harm first

Before running a change, read its diff for anything that reaches past its stated goal. Any one of these stops the review until the maintainer has looked:

- It changes `.github/` (workflows, actions, permissions, secrets) or a publish script.
- It adds a network address, an upload, telemetry, or sends a credential, token, cookie, or file anywhere it did not go before.
- It reads or writes `~/.chivgent`, a provider key, an OAuth token, or another agent's config the goal does not need.
- It adds a dependency, an install script, a binary, a minified or encoded blob, or code built from a string at run time.
- It weakens the sandbox: an unsandboxed fallback, a broader Seatbelt profile, provider keys passed into the shell environment, or a permission mode restored from a saved session.

Say which line stopped it. Do not run the change on a machine with real accounts until the maintainer has cleared it.

## What an agent does not decide

An agent does not close a pull request, block an author, or reverse a deliberate product decision. The read-only default, the fail-closed sandbox, and the split between shell cleanup and `--serve` shutdown are those decisions. See [code standards](code-standards.md).

When a review finds repeated low-value or deceptive work, the agent writes the evidence (PR numbers, dates, what was wrong) to the maintainer. The maintainer decides. Faking a test result or a verification is one of the things that gets written up. It is not something an agent answers by arguing on the PR.
