// Run `npm run build && node scripts/benchmark-streaming.mjs`.
// Local CPU/I/O microbenchmarks; no provider or network access required.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LineDecoder } from '../dist/remote/framing.js';
import { truncateTail } from '../dist/shell/truncate.js';
import { OutputAccumulator } from '../dist/shell/output.js';

async function measure(name, run) {
  await run();
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name}: ${samples[2].toFixed(2)} ms (median of 5)`);
}

const wire = Buffer.from(`${'x'.repeat(512 * 1024)}\n`);
await measure('512 KiB line in 64-byte chunks', () => {
  const decoder = new LineDecoder();
  for (let offset = 0; offset < wire.length; offset += 64) {
    decoder.push(wire.subarray(offset, offset + 64));
  }
});
const longLine = '中文😀x'.repeat(400_000);
await measure('4.2 MiB Unicode line truncation', () => {
  truncateTail(longLine);
});
const directory = await mkdtemp(path.join(tmpdir(), 'chivgent-bench-'));
try {
  const chunk = Buffer.from('中文😀x'.repeat(400));
  await measure('4.2 MiB streaming shell output', async () => {
    const accumulator = new OutputAccumulator({ tempDirectory: directory });
    for (let i = 0; i < 1000; i++) accumulator.append(chunk);
    accumulator.finish();
    accumulator.snapshot();
    await accumulator.close();
    await rm(accumulator.snapshot().fullOutputPath);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
