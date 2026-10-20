import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cleanupE2EResources, listOwnedDescendants, shutdownElectron } from "./e2e-lifecycle.mjs";
import { requireUiEntry } from "./e2e-ui-guard.mjs";

requireUiEntry();
const { _electron: electron } = await import("playwright-core");

// Exercise the built app through its real IPC, host, Provider adapter and
// workspace tools. Only this loopback fixture receives model requests.
const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "chivgent desktop 中文-"));
const project = join(root, "chivopic");
const auth = join(root, "auth");
const hostPidFile = join(root, "host.pid");
await mkdir(project);
await mkdir(auth);
const canonicalProject = await realpath(project);
const marker = "fixture-project-入口-123";
await writeFile(join(project, "README.md"), `${marker}\n`);
const requests = [];
const fixtureErrors = [];
let activeApp;
let stage = "setup";
let endpointPath = "";
let endpoint = "";
// A hung fixture must report which assertion/cleanup stage stopped progressing.
// Electron's utility process is reaped by its parent watchdog on hard exit.
const watchdog = setTimeout(() => {
  console.error(`Electron read-only E2E deadline exceeded during: ${stage}`);
  process.exitCode = 1;
  try { activeApp?.process()?.kill("SIGKILL"); } catch {}
  void readFile(hostPidFile, "utf8").then(value => {
    const pid = Number(value.trim());
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }).catch(() => {});
}, 120_000);
watchdog.unref();
const progress = (label) => {
  stage = label;
  console.log(`Electron E2E: ${label}`);
};
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, `${endpointPath}/chat/completions`);
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

let runError;
try {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  endpointPath = `/v1/${"long-endpoint-segment-".repeat(5)}`;
  endpoint = `http://127.0.0.1:${server.address().port}${endpointPath}`;
  await rm(hostPidFile, { force: true });
  const environment = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "DISPLAY", "XAUTHORITY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  activeApp = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [resolve(desktop), `--user-data-dir=${join(root, "profile")}`],
    cwd: root,
    env: { ...environment, CHIVGENT_DESKTOP_HOST_PID_FILE: hostPidFile, CHIVGENT_HOME: auth, CHIVGENT_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "desktop-fixture", OPENAI_BASE_URL: endpoint },
  });
  progress("Electron launched; waiting for host readiness");
  const page = await activeApp.firstWindow();
  progress("checking default information hierarchy");
  await page.locator(".dot.ready").first().waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId("provider-select").isVisible().catch(() => false), false,
    "provider controls must stay hidden until the user opens settings");
  assert.equal(await page.getByTestId("compatible-endpoint").isVisible().catch(() => false), false,
    "request endpoint must not be visible in the default view");
  assert.equal(await page.getByTestId("runtime-config").isVisible().catch(() => false), false,
    "effective runtime configuration must stay out of the default view");
  assert.equal(await page.getByTestId("host-status").isVisible().catch(() => false), false,
    "normal host connectivity must not occupy the main view");
  assert.equal(await page.getByText(canonicalProject, { exact: true }).count(), 0,
    "the full project path must not be repeated in the conversation view");
  assert.equal(await page.getByText("Agent host 已连接", { exact: true }).count(), 0,
    "normal host diagnostics must not occupy the default view");
  await page.getByTestId("status-action").click();
  await page.getByTestId("host-status").getByText("Agent host 已连接", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭状态详情" }).click();
  await activeApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, project);
  await page.getByRole("button", { name: "选择项目目录", exact: false }).click();
  assert.equal(await page.getByText(canonicalProject, { exact: true }).count(), 0,
    "the selected full path stays out of the conversation view");
  assert.equal(await page.getByTestId("user-message").count(), 0,
    "a newly selected project starts with an empty visible conversation");
  if (process.argv[2] !== undefined) await page.screenshot({ path: resolve(process.argv[2]) });
  await page.getByRole("button", { name: "折叠侧栏" }).click();
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
  await page.waitForFunction(() => window.innerWidth === 880);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth &&
    [...document.querySelectorAll(".stage-head button")].every((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    })), "the narrow window must keep header controls within the viewport");
  if (process.argv[3] !== undefined) await page.screenshot({ path: resolve(process.argv[3]) });
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780));
  await page.waitForFunction(() => window.innerWidth === 1180);
  await page.locator(".project-identity").click();
  assert.equal(await page.locator(".path-value").innerText(), canonicalProject,
    "project details must expose the complete selected path");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => {
        if (window.__failDesktopClipboardFixture) throw new Error("fixture clipboard unavailable");
        window.__desktopClipboardFixture = text;
      },
      readText: async () => window.__desktopClipboardFixture ?? "",
    } });
  });
  await page.evaluate(() => { window.__failDesktopClipboardFixture = true; });
  await page.getByRole("button", { name: "复制完整路径" }).click();
  await page.getByRole("alert").getByText("复制失败", { exact: false }).waitFor();
  await page.evaluate(() => { window.__failDesktopClipboardFixture = false; });
  await page.getByRole("button", { name: "复制完整路径" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), canonicalProject,
    "project details must copy the exact selected path");
  await page.getByRole("status").getByText("已复制完整路径", { exact: false }).waitFor();
  await page.getByRole("button", { name: "关闭详情" }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("project-identity")), true,
    "closing project details must return focus to its opening control");
  progress("project selected; verifying provider change clears manual model");
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("provider-select").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-select"]')?.value === "openai-compatible");
  await page.getByTestId("compatible-endpoint").getByText(endpoint, { exact: false }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("provider-select").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "设置",
    "Escape must return focus to the settings opener");
  await page.getByRole("button", { name: "设置" }).click();
  // A manual model override belongs to the provider that was selected when it was typed.
  await page.getByTestId("model-input").fill("stale-model");
  await page.getByTestId("provider-select").selectOption("deepseek");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("deepseek-only");
  await page.getByTestId("provider-select").selectOption("openai-compatible");
  assert.equal(await page.getByTestId("model-input").inputValue(), "");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByTestId("composer").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  progress("provider/model controls verified; starting project read");
  await page.getByTestId("composer").fill("解释当前项目");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 20_000 });
  assert.equal(await page.getByTestId("compatible-endpoint").count(), 0,
    "endpoint stays hidden after a completed run");
  assert.equal(await page.getByTestId("runtime-config").count(), 0,
    "the last effective config stays hidden after a completed run");
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("runtime-config").getByText(endpoint, { exact: false }).waitFor();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByTestId("tool-activity").getByRole("button").click();
  assert.ok((await page.getByTestId("tool-activity").innerText()).includes(marker));
  assert.ok((await page.getByTestId("assistant-message").last().innerText()).includes(marker));
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
  await page.waitForFunction(() => window.innerWidth === 880);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth &&
    [...document.querySelectorAll(".stage-head button")].every((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    })), "the narrow window must keep header controls within the viewport");
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("compatible-endpoint").getByText(endpoint, { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector(".details-dialog");
    const value = dialog?.querySelector(".path-value");
    if (!dialog || !value) return false;
    const dialogBounds = dialog.getBoundingClientRect();
    const valueBounds = value.getBoundingClientRect();
    return document.documentElement.scrollWidth <= window.innerWidth &&
      dialogBounds.left >= 0 && dialogBounds.right <= window.innerWidth && valueBounds.right <= dialogBounds.right;
  }), "the long endpoint must wrap inside settings at narrow width");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator(".project-identity").click();
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector(".details-dialog");
    const value = dialog?.querySelector(".path-value");
    if (!dialog || !value) return false;
    const dialogBounds = dialog.getBoundingClientRect();
    const valueBounds = value.getBoundingClientRect();
    return dialogBounds.left >= 0 && dialogBounds.right <= window.innerWidth && valueBounds.right <= dialogBounds.right;
  }), "the complete project path must wrap inside project details at narrow width");
  await page.getByRole("button", { name: "关闭详情" }).click();
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780));
  await page.waitForFunction(() => window.innerWidth === 1180);
  progress("project read and tool output verified; testing context carryover");
  await page.getByTestId("composer").fill("继续追问");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").filter({ hasText: "上下文仍在" }).last().waitFor({ timeout: 15_000 });
  await page.getByTestId("run-status").getByText("已完成").waitFor();
  progress("multi-turn verified; testing missing credential recovery");
  const beforeMissingKey = requests.length;
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("provider-select").selectOption("deepseek");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByTestId("composer").fill("缺凭证测试");
  await page.getByTestId("send").click();
  await page.getByTestId("notice").filter({ hasText: "API key" }).waitFor();
  await page.getByTestId("run-status").getByText("出错").waitFor();
  assert.equal(requests.length, beforeMissingKey);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByTestId("provider-select").selectOption("openai-compatible");
  await page.getByTestId("model-input").fill("desktop-fixture");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "展开侧栏" }).click();
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
  await page.getByRole("button", { name: "设置" }).click();
  assert.equal(await page.getByTestId("provider-select").isDisabled(), true,
    "provider cannot change during a run");
  assert.equal(await page.getByTestId("model-input").isDisabled(), true,
    "model cannot change during a run");
  assert.equal(await page.getByTestId("runtime-config").isVisible(), true,
    "the active run configuration remains inspectable while controls are disabled");
  await page.getByRole("button", { name: "完成", exact: true }).click();
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
  const longProjectName = "x".repeat(180);
  const longNameProject = join(root, longProjectName);
  await mkdir(longNameProject);
  const canonicalLongNameProject = await realpath(longNameProject);
  await activeApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, longNameProject);
  await page.getByRole("button", { name: "切换项目目录" }).click();
  await page.waitForFunction((name) => document.querySelector(".project-identity")?.textContent?.includes(name), longProjectName);
  await activeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 600));
  await page.waitForFunction(() => window.innerWidth === 880);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "a long project basename must not overflow the narrow conversation header");
  await page.locator(".project-identity").click();
  assert.ok(await page.evaluate(() => {
    const dialog = document.querySelector(".details-dialog");
    const name = dialog?.querySelector(".detail-block strong");
    if (!dialog || !name) return false;
    const d = dialog.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    return d.left >= 0 && d.right <= innerWidth && n.left >= d.left && n.right <= d.right &&
      dialog.scrollWidth <= dialog.clientWidth;
  }), "a long project basename must wrap inside project details at narrow width");
  assert.equal(await page.locator(".path-value").innerText(), canonicalLongNameProject);
  progress("long project basename layout verified; closing Electron");
  await page.getByRole("button", { name: "关闭详情" }).click();
  console.log(JSON.stringify({ selectedProjectRead: true, toolOutputVisible: true,
    multiTurn: true, missingCredentialRecovery: true, cancellation: true, continueAfterStop: true,
    readonlyWorkspace: true, noCredentialWrites: true, minimumWindowLayout: true,
    providerRequests: requests.length }, null, 2));
} catch (error) {
  runError = error;
} finally {
  const cleanupErrors = [];
  try {
    progress("requesting the application's normal quit path");
    if (activeApp !== undefined) {
      const closing = activeApp;
      if (process.env.CHIVGENT_E2E_HANG_QUIT === "1") {
        const hostPid = Number((await readFile(hostPidFile, "utf8")).trim());
        const electronPid = closing.process().pid;
        const descendants = await listOwnedDescendants(electronPid);
        console.log(JSON.stringify({ e2eFaultInjection: "prevent-before-quit", root, hostPid, electronPid, descendants }));
        await closing.evaluate(({ app }) => app.on("before-quit", event => event.preventDefault()));
      }
      await shutdownElectron({ app: closing, hostPidFile });
      activeApp = undefined;
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  progress("closing fixture HTTP server and deleting temporary project");
  try { await cleanupE2EResources({ server, root }); }
  catch (error) { cleanupErrors.push(error); }
  clearTimeout(watchdog);
  if (cleanupErrors.length) {
    runError = runError
      ? new AggregateError([runError, ...cleanupErrors], "E2E scenario and teardown both failed")
      : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "E2E teardown failed");
  }
}
if (runError) throw runError;
