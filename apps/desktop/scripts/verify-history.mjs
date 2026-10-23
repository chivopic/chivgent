import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cleanupE2EResources, shutdownElectron } from './e2e-lifecycle.mjs';
import { requireUiEntry } from './e2e-ui-guard.mjs';

requireUiEntry();

// Run against the built app with a temporary profile, project, history, and localhost model.
// Optional arguments: desktop directory, screenshot destination.
const desktop = process.argv[2] === undefined
  ? fileURLToPath(new URL('../', import.meta.url))
  : resolve(process.argv[2]);
const require = createRequire(join(desktop, 'package.json'));
const { _electron: electron } = require('playwright-core');
const root = await mkdtemp(join(tmpdir(), 'chivgent-history-e2e-'));
const project = join(root, 'chivopic');
const auth = join(root, 'auth');
const hostPidFile = join(root, 'host.pid');
await mkdir(project); await mkdir(auth);
const canonicalProject = await realpath(project);
const marker = 'history-real-file-123';
await writeFile(join(project, 'README.md'), marker + '\n');
let activeApp;
let finishStream;
let stage = 'setup';
const requests = [];
const fixtureErrors = [];
const progress = label => { stage = label; console.log(`History E2E: ${label}`); };
const watchdog = setTimeout(() => {
  console.error(`History E2E timed out: ${stage}`);
  process.exitCode = 1;
  try { activeApp?.process()?.kill('SIGKILL'); } catch {}
  void readFile(hostPidFile, 'utf8').then(value => {
    const pid = Number(value.trim());
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }).catch(() => {});
}, 100_000);
watchdog.unref();
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-key');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['list_files', 'question', 'read_file', 'search_text', 'update_plan']);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: 'history-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const last = body.messages.at(-1);
    if (last?.content === '崩溃恢复测试') {
      send({ role: 'assistant', content: '崩溃前的流式片段' });
    } else if (last?.role === 'tool') {
      assert.ok(last.content.includes(marker));
      send({ role: 'assistant', content: '恢复前的流式片段' });
      finishStream = () => { send({ content: `；完成 ${marker}` }); send({}, 'stop'); response.end('data: [DONE]\n\n'); };
    } else if (last?.content === '重启后继续') {
      assert.equal(body.messages.filter(m => m.role === 'user' && m.content === '读取文件并验证恢复').length, 1, 'resumed conversation must contain the original prompt once');
      assert.ok(body.messages.some(m => m.role === 'assistant' && m.content?.includes(marker)), 'resumed model context includes prior result');
      send({ role: 'assistant', content: '重启后的上下文仍在' }); send({}, 'stop'); response.end('data: [DONE]\n\n');
    } else {
      assert.equal(requests.length, 1, 'refresh/restart must never resubmit a prompt');
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'history-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md', start_line: 1, line_count: 20 }) } }] });
      send({}, 'tool_calls'); response.end('data: [DONE]\n\n');
    }
  } catch (error) { console.error('History fixture:', error.message); fixtureErrors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); }
});
const environment = {};
for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'DISPLAY', 'XAUTHORITY']) if (process.env[key] !== undefined) environment[key] = process.env[key];
async function launch(endpoint) {
  await rm(hostPidFile, { force: true });
  activeApp = await electron.launch({ executablePath: require('electron'), args: [desktop, `--user-data-dir=${join(root, 'profile')}`], cwd: root,
    env: { ...environment, CHIVGENT_DESKTOP_HOST_PID_FILE: hostPidFile, CHIVGENT_DESKTOP_HISTORY_DIR: join(root, 'history'), CHIVGENT_HOME: auth, CHIVGENT_PROVIDER: 'openai-compatible', OPENAI_API_KEY: 'fixture-key', OPENAI_MODEL: 'history-fixture', OPENAI_BASE_URL: endpoint } });
  const page = await activeApp.firstWindow();
  await page.locator('[data-testid="status-action"] .dot.ready').waitFor({ timeout: 15_000 });
  await page.getByTestId('status-action').click();
  await page.getByTestId('host-status').getByText('Agent host 已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭状态详情' }).click();
  return page;
}
async function quit() {
  if (!activeApp) return;
  const closing = activeApp;
  await shutdownElectron({ app: closing, hostPidFile });
  activeApp = undefined;
}
let runError;
try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  let page = await launch(endpoint);
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-select"]')?.value === 'openai-compatible');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await activeApp.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  await page.getByRole('button', { name: '选择项目目录', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('.project-identity')?.textContent?.includes('chivopic'));
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByTestId('provider-select').selectOption('deepseek');
  await page.getByTestId('model-input').fill('manual-model');
  await page.evaluate(async () => {
    await window.chivgent.initialize();
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  assert.equal(await page.getByTestId('provider-select').inputValue(), 'deepseek', 'resynchronizing history must preserve the user-selected Provider');
  assert.equal(await page.getByTestId('model-input').inputValue(), 'manual-model');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.project-identity').click();
  assert.equal(await page.locator('.path-value').innerText(), canonicalProject, 'snapshot hydration retains the selected canonical project path');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByTestId('provider-select').selectOption('openai-compatible');
  await page.getByTestId('model-input').fill('history-fixture');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByTestId('composer').fill('读取文件并验证恢复');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: '恢复前的流式片段' }).waitFor({ timeout: 15_000 });
  assert.equal(requests.length, 2);
  await page.getByRole('button', { name: '设置' }).click();
  assert.equal(await page.getByTestId('provider-select').isDisabled(), true, 'active-session settings stay inspectable but cannot be edited');
  const activeConfig = await page.getByTestId('runtime-config').innerText();
  assert.match(activeConfig, /当前运行的有效配置/);
  assert.match(activeConfig, /history-fixture/);
  assert.ok(activeConfig.includes(endpoint), 'the current endpoint remains available in settings details');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  progress('reload during a live response');
  await page.reload();
  await page.locator('[data-testid="status-action"] .dot.ready').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('.project-identity')?.textContent?.includes('chivopic'));
  await page.getByTestId('assistant-message').filter({ hasText: '恢复前的流式片段' }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByTestId('user-message').count(), 1);
  assert.equal(await page.getByTestId('tool-activity').count(), 1);
  await page.getByTestId('stop').waitFor();
  assert.equal(requests.length, 2, 'reload must not issue a model request');
  finishStream(); finishStream = undefined;
  await page.getByTestId('run-status').getByText('已完成').waitFor();
  await page.getByTestId('assistant-message').filter({ hasText: marker }).waitFor();
  progress('normal quit and restart');
  await quit();
  page = await launch(endpoint);
  await page.waitForFunction(() => document.querySelector('.project-identity')?.textContent?.includes('chivopic'));
  await page.locator('.project-identity').click();
  assert.equal(await page.locator('.path-value').innerText(), canonicalProject, 'a fresh renderer hydrates the selected project path from the host snapshot');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByTestId('assistant-message').filter({ hasText: marker }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByTestId('user-message').count(), 1);
  assert.equal(requests.length, 2, 'startup must load history without model execution');
  await page.getByTestId('composer').fill('重启后继续');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: '重启后的上下文仍在' }).waitFor({ timeout: 10_000 });
  await page.getByTestId('run-status').getByText('已完成').waitFor();
  assert.equal(requests.length, 3);
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), marker + '\n');
  assert.deepEqual(await readdir(project), ['README.md']);
  assert.deepEqual(await readdir(auth), []);
  assert.deepEqual(fixtureErrors, []);
  progress('host crash and explicit page reconnect');
  await page.getByTestId('composer').fill('崩溃恢复测试');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: '崩溃前的流式片段' }).waitFor();
  assert.equal(requests.length, 4);
  const hostPid = Number(await readFile(join(root, 'host.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0);
  process.kill(hostPid, 'SIGKILL');
  await page.locator('[data-testid="status-action"] .dot.bad').waitFor({ timeout: 10_000 });
  await page.getByTestId('status-action').click();
  await page.getByTestId('host-status').getByText(/退出/).waitFor();
  await page.getByRole('button', { name: '关闭状态详情' }).click();
  await page.reload();
  await page.locator('[data-testid="status-action"] .dot.ready').waitFor({ timeout: 15_000 });
  await page.getByTestId('status-action').click();
  await page.getByTestId('host-status').getByText('Agent host 已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭状态详情' }).click();
  await page.getByTestId('notice').filter({ hasText: '结果未知' }).waitFor();
  assert.equal(await page.getByTestId('user-message').count(), 3);
  assert.equal(requests.length, 4, 'crash recovery must never replay the interrupted prompt');
  assert.deepEqual(fixtureErrors, []);
  if (process.argv[3]) await page.screenshot({ path: resolve(process.argv[3]) });
  console.log(JSON.stringify({ preservedProviderSelection: true, liveReload: true, onePromptAfterReload: true, toolRestored: true, noReplay: true, restartHistory: true, resumedModelContext: true, crashedRunUnknown: true, noCrashReplay: true, readonlyWorkspace: true, noCredentialWrites: true, providerRequests: requests.length }, null, 2));
} catch (error) {
  runError = error;
} finally {
  const cleanupErrors = [];
  finishStream?.();
  try { await quit(); } catch (error) { cleanupErrors.push(error); }
  try { await cleanupE2EResources({ server, root }); }
  catch (error) { cleanupErrors.push(error); }
  clearTimeout(watchdog);
  if (cleanupErrors.length) {
    runError = runError
      ? new AggregateError([runError, ...cleanupErrors], "History E2E scenario and teardown both failed")
      : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "History E2E teardown failed");
  }
}
if (runError) throw runError;
