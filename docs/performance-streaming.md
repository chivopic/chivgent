# Streaming performance

The remote line decoder now scans each decoded chunk once and joins fragments
only when a newline arrives. Previously every small transport chunk rescanned
and measured the entire unfinished line, causing quadratic work as a line grew.
The decoded UTF-8 byte limit now also applies to newline-terminated lines within
a single chunk; oversized complete lines previously bypassed the check.

Shell tail truncation now walks backward over UTF-16 code points, stopping at the
byte budget. It no longer spreads the entire input into a character array, and
the rolling output accumulator uses the same implementation. Surrogate pairs
and unpaired surrogates retain the previous UTF-8 byte accounting behavior.

## Reproduce

```sh
npm run build
node scripts/benchmark-streaming.mjs
```

Each scenario is warmed up once and reports the median of five runs. The shell
scenario includes spilling and closing the output file. Temporary benchmark
files are removed after use. No model calls or network access are required.

Observed locally on macOS arm64, Node v26.8.1, comparing commit `85975ad` with
this change, using the same script and inputs:

| Scenario | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| 512 KiB line received in 64-byte chunks | 228.30 ms | 1.66 ms | 138× |
| 4.2 MiB Unicode line truncated to default tail budget | 10.47 ms | 0.87 ms | 12× |
| 4.2 MiB Unicode shell output in 1,000 chunks | 939.08 ms | 100.33 ms | 9.4× |

These are local microbenchmarks, not end-to-end agent latency measurements.
Provider latency, filesystem speed, chunk sizes, and output volume affect the
improvement users see. Timing thresholds are deliberately not CI assertions.

## Verification

`npm run check`, `npm run build`, and all 445 tests across 28 files pass.
On macOS, run tests with `TMPDIR=/private/tmp npm test` to keep Unix socket paths
within the platform limit; the runner must permit local socket listeners.
Regression tests cover byte-by-byte Unicode framing, multiple and blank lines,
completed-line limits, UTF-8 boundaries (including malformed surrogate input),
and repeated rolling-tail trimming with full spill-file preservation.
