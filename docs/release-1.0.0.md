# chivgent 1.0.0

This release makes the terminal workflow easier to use without changing the
agent's existing session format or workspace permission defaults.

## Highlights

- The rolling TUI has a compact welcome view, clearer live output, and a
  Ctrl+C exit at an idle prompt. During an answer, Ctrl+C still cancels that
  answer and keeps the session.
- Typing `/` opens an inline command menu. Arrow keys select commands without
  moving the draft to a new input line.
- `/provider` opens a keyboard-driven Provider picker. Selecting a Provider
  with no configured key immediately prompts for it with hidden input. An
  existing key is reused; `/login` remains available to replace one.
- `/model` changes the active Provider's model. `/endpoint` sets the URL for a
  custom OpenAI-compatible Provider. A key can be saved before the model or
  endpoint is configured.
- Provider switching preserves the conversation and keeps credentials scoped
  to their Provider.

## Upgrade

```sh
chivgent update --check
chivgent update
```

Older installations can run `npm install -g chivgent@1.0.0`. Node.js 22 or
newer is required. Run `chivgent --tui` to use the new interaction flow.

## Validation

The release gate covers TypeScript checks, automated tests, a production build,
and an npm package dry run. The TUI Provider selection and hidden key prompt
were also exercised in a real terminal.
