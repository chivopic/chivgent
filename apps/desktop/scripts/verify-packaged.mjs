import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireUiEntry } from "./e2e-ui-guard.mjs";

requireUiEntry();
const { _electron: electron } = await import("playwright-core");

const sourceApp = process.argv[2];
if (sourceApp === undefined || !existsSync(sourceApp)) {
  console.error("Usage: node scripts/verify-packaged.mjs <path-to-chivgent.app> [--allow-ui]");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "chivgent-desktop-m0-"));
function isolatedLaunch(label) {
  const userData = join(root, `${label}-user-data`);
  const authHome = join(root, `${label}-auth`);
  const historyDirectory = join(root, `${label}-history`);
  const pidFile = join(root, `${label}-host.pid`);
  for (const directory of [userData, authHome, historyDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    args: [`--user-data-dir=${userData}`],
    pidFile,
    env: { ...process.env, CHIVGENT_DESKTOP_HOST_PID_FILE: pidFile,
      CHIVGENT_DESKTOP_HISTORY_DIR: historyDirectory, CHIVGENT_HOME: authHome,
      CHIVGENT_DESKTOP_DEMO: "1" },
  };
}
const appPath = join(root, "chivgent.app");
const copied = spawnSync("ditto", [sourceApp, appPath], { encoding: "utf8" });
if (copied.status !== 0) {
  console.error(copied.stderr || copied.stdout);
  process.exit(1);
}
const executable = join(appPath, "Contents", "MacOS", "chivgent");

const report = {
  copiedOutsideSourceTree: !appPath.includes("/Users/chiv/developer/chivgent"),
  executable,
  streaming: false,
  tool: false,
  stopped: false,
  completed: false,
  hostExitVisible: false,
  spawnFailureVisible: false,
  hostGoneAfterQuit: false,
  compositionIgnored: false,
  closeHidesWindow: false,
  concurrentInitialize: false,
  partialTextSettled: false,
};

const primary = isolatedLaunch("primary");
const app = await electron.launch({
  executablePath: executable,
  args: primary.args,
  cwd: root,
  env: primary.env,
});

try {
  const page = await app.firstWindow();
  await page.locator(".dot.ready").first().waitFor({ timeout: 20_000 });
  report.normalHostMessageHidden = await page.getByTestId("host-status").count() === 0;
  report.providerControlsHidden = await page.getByTestId("provider-select").count() === 0;
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, root);
  await page.getByTestId("status-action").click();
  await page.getByTestId("host-status").getByText("Agent host 已连接", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭状态详情" }).click();
  await page.getByTestId("demo-notice").getByText("离线演示", { exact: false }).waitFor();
  await page.getByRole("button", { name: "选择项目目录" }).click();
  await page.locator(".project-path").getByText(root.split(/[\\/]/).filter(Boolean).at(-1), { exact: true }).waitFor({ timeout: 5_000 });
  await page.locator(".project-identity").click();
  await page.getByText(realpathSync(root), { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭详情" }).click();
  const initializeResults = await page.evaluate(async () =>
    Promise.all([window.chivgent.initialize(), window.chivgent.initialize()]),
  );
  report.concurrentInitialize = initializeResults.every((result) => result.ok);

  await page.getByTestId("composer").fill("组合输入");
  await page.getByTestId("composer").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart"));
  });
  await page.keyboard.press("Enter");
  report.compositionIgnored = await page.getByTestId("user-message").count() === 0;
  await page.getByTestId("composer").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend"));
  });

  await page.getByTestId("composer").fill("文本出现后立即取消");
  await page.getByTestId("send").click();
  const partialAnswer = page.getByTestId("assistant-message").last();
  await partialAnswer.getByText("我会", { exact: false }).waitFor({ timeout: 15_000 });
  const partialText = await partialAnswer.innerText();
  await page.getByTestId("stop").click();
  await page.getByTestId("run-status").getByText("已停止").waitFor({ timeout: 15_000 });
  await page.locator(".caret").waitFor({ state: "detached", timeout: 5_000 });
  const settledText = await partialAnswer.innerText();
  report.partialTextSettled = partialText.length > 0 && settledText.length > 0 && await page.locator(".caret").count() === 0;

  await page.getByTestId("composer").fill("检查当前任务");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").last().getByText("我会", { exact: false }).waitFor({ timeout: 15_000 });
  await page.getByTestId("tool-activity").getByText("demo_progress").waitFor({ timeout: 15_000 });
  report.streaming = true;
  report.tool = true;
  await page.getByTestId("stop").click();
  await page.getByTestId("run-status").getByText("已停止").waitFor({ timeout: 15_000 });
  report.stopped = true;

  await page.getByTestId("composer").fill("再跑一次完整演示");
  await page.getByTestId("send").click();
  await page.getByTestId("run-status").getByText("已完成").waitFor({ timeout: 20_000 });
  await page.getByTestId("tool-activity").last().click();
  await page.getByText("Demo checks passed.").waitFor({ timeout: 5_000 });
  report.completed = true;
  const hidden = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    return { visible: window.isVisible(), destroyed: window.isDestroyed() };
  });
  const hostStillUp = spawnSync("ps", ["-p", readFileSync(primary.pidFile, "utf8").trim()], { encoding: "utf8" });
  report.closeHidesWindow = hidden.visible === false && hidden.destroyed === false && hostStillUp.status === 0;
} finally {
  await app.close();
}

const hostPid = readFileSync(primary.pidFile, "utf8").trim();
const leftover = spawnSync("ps", ["-p", hostPid], { encoding: "utf8" });
report.hostGoneAfterQuit = leftover.status !== 0;

const exitProfile = isolatedLaunch("exit");
const exitApp = await electron.launch({
  executablePath: executable,
  args: exitProfile.args,
  cwd: root,
  env: exitProfile.env,
});
try {
  const page = await exitApp.firstWindow();
  await exitApp.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, root);
  await page.locator(".status-action .dot.ready").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "选择项目目录" }).click();
  await page.locator(".project-path").getByText(root.split(/[\\/]/).filter(Boolean).at(-1), { exact: true }).waitFor({ timeout: 5_000 });
  await page.getByTestId("composer").fill("中途退出 host");
  await page.getByTestId("send").click();
  await page.getByTestId("tool-activity").waitFor({ timeout: 15_000 });
  process.kill(Number(readFileSync(exitProfile.pidFile, "utf8")), "SIGTERM");
  await page.getByTestId("notice").getByText("退出", { exact: false }).waitFor({ timeout: 10_000 });
  report.hostExitVisible = true;
} finally {
  await exitApp.close();
}

const exitHostPid = readFileSync(exitProfile.pidFile, "utf8").trim();
const exitHostLeftover = spawnSync("ps", ["-p", exitHostPid], { encoding: "utf8" });
report.exitHostGoneAfterQuit = exitHostLeftover.status !== 0;

const unpackedHost = join(appPath, "Contents", "Resources", "app.asar.unpacked", "out", "host");
const hostFile = ["index.mjs", "index.cjs", "index.js"]
  .map((name) => join(unpackedHost, name))
  .find((candidate) => existsSync(candidate));
if (hostFile === undefined) {
  throw new Error(`No host bundle under ${unpackedHost}`);
}
const hidden = `${hostFile}.hidden`;
renameSync(hostFile, hidden);
const brokenProfile = isolatedLaunch("broken");
const broken = await electron.launch({ executablePath: executable, args: brokenProfile.args, cwd: root, env: brokenProfile.env });
try {
  const page = await broken.firstWindow();
  await page.getByTestId("notice").waitFor({ timeout: 15_000 });
  const text = await page.getByTestId("notice").innerText();
  report.spawnFailureVisible = text.includes("缺失") || text.includes("退出") || text.includes("失败");
} finally {
  await broken.close();
  renameSync(hidden, hostFile);
}

const destination = join(root, "report.json");
writeFileSync(destination, JSON.stringify(report, null, 2));
writeFileSync("/tmp/chivgent-desktop-m0-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (Object.values(report).some((value) => value === false)) {
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
