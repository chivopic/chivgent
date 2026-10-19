import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfflineE2EFixture } from './offline-e2e-fixture.mjs';
import { finishReplay, replayFragmentedPrefix, replayProtocol } from './protocol-replay.mjs';

// Run against the built app with a temporary profile, project, history, and localhost model.
// Optional arguments: desktop directory, screenshot destination.
const desktop = process.argv[2] === undefined
  ? fileURLToPath(new URL('../', import.meta.url))
  : resolve(process.argv[2]);
let finishStream;
const marker = 'history-real-file-123';
let fixture;
const handler = async ({ body, response, requests }) => {
  assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['list_files', 'read_file', 'search_text', 'update_plan']);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const last = body.messages.at(-1);
  if (last?.content === '崩溃恢复测试') {
    await replayFragmentedPrefix(response, 'cancel-prefix.synthetic.sse', { model: body.model, hold: true });
  } else if (last?.role === 'tool') {
    assert.ok(last.content.includes(marker));
    response.write(`data: ${JSON.stringify({ id: 'history-partial', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '恢复前的流式片段' }, finish_reason: null }] })}\n\n`);
    finishStream = () => {
      response.write(`data: ${JSON.stringify({ id: 'history-partial', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: `；完成 ${marker}` }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'history-partial', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      finishReplay(response);
    };
  } else if (last?.content === '重启后继续') {
    assert.equal(body.messages.filter(m => m.role === 'user' && m.content === '读取文件并验证恢复').length, 1, 'resumed conversation must contain the original prompt once');
    assert.ok(body.messages.some(m => m.role === 'assistant' && m.content?.includes(marker)), 'resumed model context includes prior result');
    await replayProtocol(response, 'assistant-text.synthetic.sse', { model: body.model, replacements: { MARKER: marker }, chunkBytes: 7 });
  } else {
    assert.equal(requests.length, 1, 'refresh/restart must never resubmit a prompt');
    await replayProtocol(response, 'read-file-tool.synthetic.sse', { model: body.model, chunkBytes: 5 });
  }
};
try {
  fixture = await createOfflineE2EFixture({ desktop, prefix: 'chivgent-history-e2e', model: 'history-fixture', requestHandler: handler, timeoutMs: 100_000 });
  const { project, auth, requests, fixtureErrors, hostPidFile } = fixture;
  await writeFile(join(project, 'README.md'), marker + '\n');
  const launch = async () => {
    return fixture.launch();
  };
  const first = await launch();
  let page = first.page;
  await first.app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-select"]')?.value === 'openai-compatible');
  await page.getByRole('button', { name: '选择项目目录', exact: false }).click();
  fixture.progress('after-project-selected');
  await page.getByTestId('provider-select').selectOption('deepseek');
  await page.getByTestId('model-input').fill('manual-model');
  await page.evaluate(async () => {
    await window.chivgent.initialize();
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  assert.equal(await page.getByTestId('provider-select').inputValue(), 'deepseek', 'resynchronizing history must preserve the user-selected Provider');
  assert.equal(await page.getByTestId('model-input').inputValue(), 'manual-model');
  await page.getByTestId('provider-select').selectOption('openai-compatible');
  await page.getByTestId('model-input').fill('history-fixture');
  await page.getByTestId('composer').fill('读取文件并验证恢复');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: '恢复前的流式片段' }).waitFor({ timeout: 15_000 });
  assert.equal(requests.length, 2);
  fixture.progress('reload during a live response');
  await page.reload();
  await page.getByTestId('host-status').getByText('已连接', { exact: false }).waitFor();
  await page.getByTestId('assistant-message').filter({ hasText: '恢复前的流式片段' }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByTestId('user-message').count(), 1);
  assert.equal(await page.getByTestId('tool-activity').count(), 1);
  await page.getByTestId('stop').waitFor();
  assert.equal(requests.length, 2, 'reload must not issue a model request');
  finishStream(); finishStream = undefined;
  await page.getByTestId('run-status').getByText('已完成').waitFor();
  await page.getByTestId('assistant-message').filter({ hasText: marker }).waitFor();
  fixture.progress('normal quit and restart');
  await fixture.quitApp();
  ({ page } = await launch());
  await page.getByTestId('assistant-message').filter({ hasText: marker }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByTestId('user-message').count(), 1);
  assert.equal(requests.length, 2, 'startup must load history without model execution');
  await page.getByTestId('composer').fill('重启后继续');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: `A synthetic streamed answer includes ${marker}.` }).last().waitFor({ timeout: 10_000 });
  await page.getByTestId('run-status').getByText('已完成').waitFor();
  assert.equal(requests.length, 3);
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), marker + '\n');
  assert.deepEqual(await readdir(project), ['README.md']);
  assert.deepEqual(await readdir(auth), []);
  assert.deepEqual(fixtureErrors, []);
  fixture.progress('host crash and explicit page reconnect');
  await page.getByTestId('composer').fill('崩溃恢复测试');
  await page.getByTestId('send').click();
  await page.getByTestId('assistant-message').filter({ hasText: 'Synthetic partial response before cancellation.' }).waitFor();
  assert.equal(requests.length, 4);
  const hostPid = Number(await readFile(hostPidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0);
  process.kill(hostPid, 'SIGKILL');
  await page.getByTestId('host-status').getByText('退出', { exact: false }).waitFor();
  await page.reload();
  await page.getByTestId('host-status').getByText('已连接', { exact: false }).waitFor({ timeout: 15_000 });
  await page.getByTestId('notice').filter({ hasText: '结果未知' }).waitFor();
  assert.equal(await page.getByTestId('user-message').count(), 3);
  assert.equal(requests.length, 4, 'crash recovery must never replay the interrupted prompt');
  assert.deepEqual(fixtureErrors, []);
  if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
  console.log(JSON.stringify({ preservedProviderSelection: true, liveReload: true, onePromptAfterReload: true, toolRestored: true, noReplay: true, restartHistory: true, resumedModelContext: true, crashedRunUnknown: true, noCrashReplay: true, readonlyWorkspace: true, noCredentialWrites: true, providerRequests: requests.length }, null, 2));
} catch (error) {
  if (fixture !== undefined) {
    const artifactPath = await fixture.captureFailure(error);
    console.error(`History E2E failure artifacts: ${artifactPath}`);
  }
  throw error;
} finally {
  finishStream?.();
  if (fixture !== undefined) await fixture.cleanup();
}
