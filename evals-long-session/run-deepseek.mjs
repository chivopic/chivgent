#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { DeepSeekChatClient } from '../dist/providers/deepseek.js';
import { loadTasks } from '../dist/evals/task.js';
import { runTasks } from '../dist/evals/runner.js';
import { toJsonReport } from '../dist/evals/report.js';
import { describeSuite, buildBaselineManifest, gitRevision } from '../dist/evals/baseline.js';
import { HeuristicTokenEstimator } from '../dist/context/token-estimator.js';
import { SYSTEM_PROMPT, modelSelectionPrompt } from '../dist/prompts.js';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (process.argv.includes(name)) {
    const value = process.argv[process.argv.indexOf(name) + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value;
  }
  return fallback;
}
const dryRun = process.argv.includes('--dry-run');
const taskRoot = path.resolve(option('--task-root', 'evals-long-session'));
const reportPath = path.resolve(option('--report', '/tmp/chivgent-deepseek-eval.json'));
const attempts = Number(option('--attempts', '3'));
const contextWindow = Number(option('--context-window', '6000'));
if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 50) throw new Error('--attempts must be from 1 to 50.');
if (!Number.isSafeInteger(contextWindow) || contextWindow < 1000) throw new Error('--context-window must be an integer of at least 1000.');

const model = 'deepseek-flash';
const tasks = await loadTasks(taskRoot);
const selected = tasks.map((task) => ({ ...task, contextWindow }));
const suite = await describeSuite(selected);
const systemPrompt = [SYSTEM_PROMPT, modelSelectionPrompt({ provider: 'deepseek', model })].join('\n');
const settings = {
  provider: 'deepseek', model, contextWindow, attempts,
  maxOutputTokensPerCall: 4096, timeoutMsPerCall: 90_000, retries: 0,
  thinking: 'provider default',
};
const settingsSha256 = createHash('sha256').update(JSON.stringify(settings)).digest('hex');
const baseline = {
  ...buildBaselineManifest(
    suite,
    await gitRevision(process.cwd()),
    { provider: 'deepseek', model, capabilities: [], attemptsOverride: attempts,
      systemPrompts: selected.map((task) => `${task.name}\n${systemPrompt}`) },
  ),
  executionSettings: settings,
  executionSettingsSha256: settingsSha256,
};
if (dryRun) {
  console.log(JSON.stringify({ kind: 'deepseek-long-session-preflight', baseline }, null, 2));
  process.exit(0);
}
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Set DEEPSEEK_API_KEY in the environment.');

const requestMeasurements = [];
const estimator = new HeuristicTokenEstimator();
let activeRequest;
const requestKind = () => activeRequest?.tools.length === 0 ? 'summary' : 'agent';
const estimate = () => activeRequest
  ? estimator.estimateMessages([
      ...activeRequest.messages,
      { role: 'user', content: activeRequest.systemPrompt },
      { role: 'user', content: JSON.stringify(activeRequest.tools) },
    ])
  : null;
const boundedFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith('https://api.deepseek.com/')) throw new Error('Unexpected eval provider endpoint.');
  const body = JSON.parse(init.body);
  body.max_tokens = settings.maxOutputTokensPerCall;
  const started = Date.now();
  try {
    const response = await fetch(input, {
      ...init,
      body: JSON.stringify(body),
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(settings.timeoutMsPerCall)])
        : AbortSignal.timeout(settings.timeoutMsPerCall),
    });
    const payload = await response.clone().json().catch(() => ({}));
    const usage = payload.usage ?? null;
    requestMeasurements.push({
      call: requestMeasurements.length + 1,
      kind: requestKind(),
      status: response.status,
      durationMs: Date.now() - started,
      model: payload.model ?? null,
      usage,
      localEstimate: estimate(),
      continuation: activeRequest?.continuation !== undefined,
      ...(response.ok ? {} : { error: { type: payload.error?.type ?? null, code: payload.error?.code ?? null } }),
    });
    return response;
  } catch (error) {
    requestMeasurements.push({
      call: requestMeasurements.length + 1,
      kind: requestKind(),
      status: null,
      durationMs: Date.now() - started,
      model: null,
      usage: null,
      localEstimate: estimate(),
      continuation: activeRequest?.continuation !== undefined,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
};
const sdk = new OpenAI({
  apiKey,
  baseURL: 'https://api.deepseek.com',
  fetch: boundedFetch,
  maxRetries: 0,
  timeout: settings.timeoutMsPerCall,
});
const client = new DeepSeekChatClient({ apiKey, model, client: sdk });
const tracedClient = { complete: async (request) => { activeRequest = request; return client.complete(request); } };
const startedAt = new Date().toISOString();
const results = await runTasks(selected, { createClient: () => tracedClient, systemPrompt, capabilities: [], attempts });
const report = toJsonReport(results, {
  provider: 'deepseek', model, version: JSON.parse(await readFile('package.json', 'utf8')).version, startedAt, baseline,
});
const artifact = { ...report, harness: settings, requestMeasurements };
const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, bytes);
const checksum = `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(reportPath)}\n`;
await writeFile(`${reportPath}.sha256`, checksum);
console.log(JSON.stringify({ reportPath, task: results[0]?.task, passed: results[0]?.passed, total: results[0]?.total }));
