# chivgent 0.18.0

This release improves streaming performance and makes the opt-in rolling TUI
more usable while preserving terminal scrollback.

## Interactive terminal

- A welcome panel shows the provider, model, workspace and session.
- Tab completes built-in and extension slash commands; readline keeps history
  and editing controls.
- Ordinary input during a run is ignored instead of corrupting the live region;
  Ctrl+C still cancels, and the prompt accepts another question afterwards.
- Chinese, combining characters and joined emoji are clipped by display columns.
- Resize repaints the existing region, and short windows retain the status line.
- Final answers go to stdout; prompts, tool activity and summaries go to stderr.
- Completed, cancelled, failed and turn-limited runs show an outcome summary.
- An offline demo is available from a source checkout with `npm run demo:tui`.

Start with `chivgent --tui`. This remains opt-in and requires stdin and stderr to
be terminals. See [the guide](tui.md).

## Streaming performance

Remote JSON Lines decoding scans only new fragments and assembles completed
lines once. Shell tail truncation traverses backward without expanding the
entire input into an array. Local component benchmarks improved by about 138×,
12× and 9.4× respectively for fragmented decoding, long-line truncation and
streaming shell output. These do not measure end-to-end model latency; inputs
and measurements are documented in [the benchmark report](performance-streaming.md).

Oversized completed remote lines now respect the existing decoded UTF-8 byte
limit, including lines received in a single chunk.

## Validation

Type checking, the complete automated test suite, build and package checks are
required before publishing. TUI interaction was also exercised in a real PTY,
including cancellation, subsequent prompts, resize, exit and redirected stdout.
Real DeepSeek API integration was not run for this release; provider behavior
was exercised with test doubles, without consuming API credits.
