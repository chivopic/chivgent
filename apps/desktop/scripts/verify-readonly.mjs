import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

// Exercise the built app through its real IPC, host, Provider adapter and
// workspace tools. Only this loopback fixture receives model requests.
const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "chivgent-desktop-readonly-"));
const project = join(root, "中文 project");
const auth = join(root, "auth");
await mkdir(project);
await mkdir(auth);
const marker = "fixture-project-入口-123";
await writeFile(join(project, "README.md"), `${marker}\n`);
const requests = [];
const fixtureErrors = [];
let activeApp;
let stage = "setup";
// A hung fixture must report which assertion/cleanup stage stopped progressing.
// Electron's utility process is reaped by its parent watchdog on hard exit.
const watchdog = setTimeout(() => {
  console.error(`Electron read-only E2E deadline exceeded during: ${stage}`);
  try { activeApp?.process()?.kill("SIGKILL"); } catch {}
  process.exit(1);
}, 120_000);
watchdog.unref();
const progress = (label) => {
  stage = label;
  console.log(`Electron E2E: ${label}`);
};
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.equal(body.model, "desktop-fixture");
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(),
      ["list_files", "read_file", "search_text", "update_plan"]);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk",
      created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    const last = body.messages.at(-1);
    if (last?.role === "user" && last.content === "取消测试") {
      send({ role: "assistant", content: "正在等待取消" });
      // The client must close the live stream when the user presses Stop.
      return;
    }
    if (last?.role === "tool") {
      assert.ok(last.content.includes(marker), "read_file must return the selected project's bytes");
      send({ role: "assistant", content: `真实工具已读到 ${marker}` });
    } else if (last?.content === "继续追问") {
      assert.ok(body.messages.some((item) => item.role === "assistant" && item.content?.includes(marker)),
        "the second prompt must include the first answer");
      send({ role: "assistant", content: "上下文仍在" });
    } else {
      send({ role: "assistant", content: "读取项目文件。", tool_calls: [{
        index: 0, id: `read-${requests.length}`, type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "README.md", start_line: 1, line_count: 20 }) },
      }] });
    }
    send({}, last?.role === "tool" || last?.content === "继续追问" ? "stop" : "tool_calls");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

try {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const environment = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "XAUTHORITY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  activeApp = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [resolve(desktop), `--user-data-dir=${join(root, "profile")}`],
    cwd: root,
    env: { ...environment, CHIVGENT_HOME: auth, CHIVGENT_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "desktop-fixture", OPENAI_BASE_URL: endpoint },
  });
  progress("Electron launched; waiting for host readiness");
  const page = await activeApp.firstWindow();
  await page.getByTestId("host-status").getByText("已连接", { exact: false }).waitFor({ timeout: 20_000 });
  await activeApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, project);
  // The renderer must inherit CHIVGENT_PROVIDER before its first request.
  await page.getByTestId("provider-select").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-select"]')?.value === "openai-compatible");
  await page.getByTestId("compatible-endpoint").getByText(endpoint, { exact: false }).waitFor();
  await page.getByRole("button", { name: "选择项目目录", exact: false }).click();
  progress("project selected; verifying provider change clears manual model");
  // A manual model override belongs to the provider that was selected when it was typed.
  await page.getByTestId("model-input").fill("stale-model");
  await page.getByTestId("provider-select").selectOption("deepseek");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("deepseek-only");
  await page.getByTestId("provider-select").selectOption("openai-compatible");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByTestId("composer").waitFor({ state: "visible" });
  progress("provider/model controls verified; starting project read");
  await page.getByTestId("composer").fill("解释当前项目");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 20_000 });
  await page.getByTestId("tool-activity").getByRole("button").click();
  assert.ok((await page.getByTestId("tool-activity").innerText()).includes(marker));
  assert.ok((await page.getByTestId("assistant-message").last().innerText()).includes(marker));
  progress("project read and tool output verified; testing context carryover");
  await page.getByTestId("composer").fill("继续追问");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").filter({ hasText: "上下文仍在" }).last().waitFor({ timeout: 15_000 });
  await page.getByTestId("run-status").getByText("已完成").waitFor();
  progress("multi-turn verified; testing missing credential recovery");
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
  await activeApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise((resolve) => {
      globalThis.__resolveDesktopProjectPicker = resolve;
    });
  });
  progress("missing credential rejection verified; testing picker and cancellation race");
  await page.getByRole("button", { name: "切换项目目录" }).click();
  await page.getByTestId("composer").fill("取消测试");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").filter({ hasText: "正在等待取消" }).waitFor();
  await activeApp.evaluate(() => {
    globalThis.__resolveDesktopProjectPicker({ canceled: false, filePaths: [process.cwd()] });
    delete globalThis.__resolveDesktopProjectPicker;
  });
  await page.getByText("运行期间不能切换项目。").waitFor();
  await page.getByTestId("stop").waitFor({ state: "visible" });

  progress("stop remains accessible after busy picker; cancelling");
  await page.getByTestId("stop").click();
  await page.getByTestId("run-status").getByText("已停止").waitFor({ timeout: 15_000 });
  await page.getByTestId("composer").fill("继续追问");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 15_000 });
  progress("cancel and continuation verified; checking file safety and layout");
  assert.equal(await readFile(join(project, "README.md"), "utf8"), `${marker}\n`);
  assert.deepEqual(await readdir(project), ["README.md"]);
  assert.deepEqual(await readdir(auth), []);
  assert.deepEqual(fixtureErrors, []);
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
  await page.waitForFunction(() => window.innerWidth === 880);
  assert.ok(await page.evaluate(() => {
    const controls = [...document.querySelectorAll(".runtime-settings input, .runtime-settings select")];
    return document.documentElement.scrollWidth <= window.innerWidth && controls.every((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    });
  }), "the supported minimum window width must keep the model controls on screen");
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780));
  await page.waitForFunction(() => window.innerWidth === 1180);
  progress("minimum window layout verified; closing Electron");
  if (process.argv[2] !== undefined) await page.screenshot({ path: resolve(process.argv[2]) });
  console.log(JSON.stringify({ selectedProjectRead: true, toolOutputVisible: true,
    multiTurn: true, missingCredentialRecovery: true, cancellation: true, continueAfterStop: true,
    readonlyWorkspace: true, noCredentialWrites: true, minimumWindowLayout: true,
    providerRequests: requests.length }, null, 2));
} finally {
  try {
    progress("requesting the application's normal quit path");
    // Playwright's close() can stall after all UI assertions have passed when
    // Electron intercepts window lifecycle events. Exercise the real app
    // before-quit / HostBridge shutdown path explicitly, then close transport.
    if (activeApp !== undefined) {
      await activeApp.evaluate(({ app }) => {
        app.quit();
      });
      progress("waiting for Electron shutdown after app.quit");
      await activeApp.close();
    }
  } finally {
    progress("closing fixture HTTP server and deleting temporary project");
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    await rm(root, { recursive: true, force: true });
    clearTimeout(watchdog);
  }
}
