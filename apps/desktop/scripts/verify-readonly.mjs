import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineE2EFixture } from "./offline-e2e-fixture.mjs";
import { replayFragmentedPrefix, replayProtocol } from "./protocol-replay.mjs";

// Exercise the built app through its real IPC, host, Provider adapter and
// workspace tools. Only this loopback fixture receives model requests.
const desktop = fileURLToPath(new URL("../", import.meta.url));
const marker = "fixture-project-入口-123";
let fixture;
let app;
let page;
const requestHandler = async ({ body, response, requests }) => {
  assert.equal(body.model, "desktop-fixture");
  assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ["list_files", "read_file", "search_text", "update_plan"]);
  const last = body.messages.at(-1);
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  if (last?.role === "user" && last.content === "取消测试") {
    await replayFragmentedPrefix(response, "cancel-prefix.synthetic.sse", { model: body.model, hold: true });
  } else if (last?.role === "tool") {
    assert.ok(last.content.includes(marker), "read_file must return the selected project's bytes");
    await replayProtocol(response, "assistant-text.synthetic.sse", { model: body.model, replacements: { MARKER: marker }, chunkBytes: 3 });
  } else if (last?.content === "继续追问") {
    assert.ok(body.messages.some((item) => item.role === "assistant" && item.content?.includes(marker)), "the second prompt must include the first answer");
    await replayProtocol(response, "assistant-text.synthetic.sse", { model: body.model, replacements: { MARKER: "上下文仍在" }, chunkBytes: 4 });
  } else {
    await replayProtocol(response, "read-file-tool.synthetic.sse", { model: body.model, chunkBytes: 3 });
  }
};

try {
  fixture = await createOfflineE2EFixture({ desktop, prefix: "chivgent-desktop-readonly", model: "desktop-fixture", requestHandler, timeoutMs: 120_000 });
  const { project, auth, endpoint, requests, fixtureErrors } = fixture;
  await writeFile(join(project, "README.md"), `${marker}\n`);
  ({ app, page } = await fixture.launch());
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, project);
  // The renderer must inherit CHIVGENT_PROVIDER before its first request.
  await page.getByTestId("provider-select").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-select"]')?.value === "openai-compatible");
  await page.getByTestId("compatible-endpoint").getByText(endpoint, { exact: false }).waitFor();
  await page.getByRole("button", { name: "选择项目目录", exact: false }).click();
  fixture.progress("after-project-selected");
  fixture.progress("project selected; verifying provider change clears manual model");
  // A manual model override belongs to the provider that was selected when it was typed.
  await page.getByTestId("model-input").fill("stale-model");
  await page.getByTestId("provider-select").selectOption("deepseek");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("deepseek-only");
  await page.getByTestId("provider-select").selectOption("openai-compatible");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByTestId("composer").waitFor({ state: "visible" });
  fixture.progress("provider/model controls verified; starting project read");
  await page.getByTestId("composer").fill("解释当前项目");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 20_000 });
  await page.getByTestId("tool-activity").getByRole("button").click();
  assert.ok((await page.getByTestId("tool-activity").innerText()).includes(marker));
  assert.ok((await page.getByTestId("assistant-message").last().innerText()).includes(marker));
  fixture.progress("project read and tool output verified; testing context carryover");
  await page.getByTestId("composer").fill("继续追问");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").filter({ hasText: "上下文仍在" }).last().waitFor({ timeout: 15_000 });
  await page.getByTestId("run-status").getByText("已完成").waitFor();
  fixture.progress("multi-turn verified; testing missing credential recovery");
  const beforeMissingKey = requests.length;
  await page.getByTestId("provider-select").selectOption("deepseek");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByTestId("composer").fill("缺凭证测试");
  await page.getByTestId("send").click();
  await page.getByTestId("notice").filter({ hasText: "API key" }).waitFor();
  await page.getByTestId("run-status").getByText("出错").waitFor();
  assert.equal(requests.length, beforeMissingKey);
  await page.getByTestId("provider-select").selectOption("openai-compatible");
  await page.getByTestId("model-input").fill("desktop-fixture");
  // Repro: open the native folder picker, start a task while it is pending,
  // then accept a project change while the task is still running.
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise((resolve) => {
      globalThis.__resolveDesktopProjectPicker = resolve;
    });
  });
  fixture.progress("missing credential rejection verified; testing picker and cancellation race");
  await page.getByRole("button", { name: "切换项目目录" }).click();
  await page.getByTestId("composer").fill("取消测试");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").filter({ hasText: "Synthetic partial response before cancellation." }).waitFor();
  await app.evaluate(() => {
    globalThis.__resolveDesktopProjectPicker({ canceled: false, filePaths: [process.cwd()] });
    delete globalThis.__resolveDesktopProjectPicker;
  });
  await page.getByText("运行期间不能切换项目。").waitFor();
  await page.getByTestId("stop").waitFor({ state: "visible" });

  fixture.progress("stop remains accessible after busy picker; cancelling");
  await page.getByTestId("stop").click();
  await page.getByTestId("run-status").getByText("已停止").waitFor({ timeout: 15_000 });
  await page.getByTestId("composer").fill("继续追问");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 15_000 });
  fixture.progress("cancel and continuation verified; checking file safety and layout");
  assert.equal(await readFile(join(project, "README.md"), "utf8"), `${marker}\n`);
  assert.deepEqual(await readdir(project), ["README.md"]);
  assert.deepEqual(await readdir(auth), []);
  assert.deepEqual(fixtureErrors, []);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
  await page.waitForFunction(() => window.innerWidth === 880);
  assert.ok(await page.evaluate(() => {
    const controls = [...document.querySelectorAll(".runtime-settings input, .runtime-settings select")];
    return document.documentElement.scrollWidth <= window.innerWidth && controls.every((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    });
  }), "the supported minimum window width must keep the model controls on screen");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780));
  await page.waitForFunction(() => window.innerWidth === 1180);
  fixture.progress("minimum window layout verified; closing Electron");
  if (process.argv[2] !== undefined) await page.screenshot({ path: process.argv[2] });
  console.log(JSON.stringify({ selectedProjectRead: true, toolOutputVisible: true,
    multiTurn: true, missingCredentialRecovery: true, cancellation: true, continueAfterStop: true,
    readonlyWorkspace: true, noCredentialWrites: true, minimumWindowLayout: true,
    providerRequests: requests.length }, null, 2));
} catch (error) {
  if (fixture !== undefined) {
    const artifactPath = await fixture.captureFailure(error);
    console.error(`Read-only E2E failure artifacts: ${artifactPath}`);
  }
  throw error;
} finally {
  if (fixture !== undefined) await fixture.cleanup();
}
