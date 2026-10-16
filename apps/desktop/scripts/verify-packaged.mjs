import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";

const sourceApp = process.argv[2];
if (sourceApp === undefined || !existsSync(sourceApp)) {
  console.error("Usage: node scripts/verify-packaged.mjs <path-to-chivgent.app>");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "chivgent-desktop-m0-"));
const appPath = join(root, "chivgent.app");
const copied = spawnSync("ditto", [sourceApp, appPath], { encoding: "utf8" });
if (copied.status !== 0) {
  console.error(copied.stderr || copied.stdout);
  process.exit(1);
}
const executable = join(appPath, "Contents", "MacOS", "chivgent");
const pidFile = join(root, "host.pid");

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
};

const app = await electron.launch({
  executablePath: executable,
  cwd: root,
  env: {
    ...process.env,
    CHIVGENT_DESKTOP_HOST_PID_FILE: pidFile,
  },
});

try {
  const page = await app.firstWindow();
  await page.getByTestId("host-status").getByText("已连接", { exact: false }).waitFor({ timeout: 20_000 });
  await page.getByTestId("composer").fill("组合输入");
  await page.getByTestId("composer").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart"));
  });
  await page.keyboard.press("Enter");
  report.compositionIgnored = await page.getByTestId("user-message").count() === 0;
  await page.getByTestId("composer").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend"));
  });
  await page.getByTestId("composer").fill("检查当前任务");
  await page.getByTestId("send").click();
  await page.getByTestId("assistant-message").getByText("我会", { exact: false }).waitFor({ timeout: 15_000 });
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
  const hostStillUp = spawnSync("ps", ["-p", readFileSync(pidFile, "utf8").trim()], { encoding: "utf8" });
  report.closeHidesWindow = hidden.visible === false && hidden.destroyed === false && hostStillUp.status === 0;
} finally {
  await app.close();
}

const hostPid = readFileSync(pidFile, "utf8").trim();
const leftover = spawnSync("ps", ["-p", hostPid], { encoding: "utf8" });
report.hostGoneAfterQuit = leftover.status !== 0;

const exitApp = await electron.launch({
  executablePath: executable,
  cwd: root,
  env: { ...process.env, CHIVGENT_DESKTOP_HOST_PID_FILE: pidFile },
});
try {
  const page = await exitApp.firstWindow();
  await page.getByTestId("host-status").getByText("已连接", { exact: false }).waitFor({ timeout: 20_000 });
  await page.getByTestId("composer").fill("中途退出 host");
  await page.getByTestId("send").click();
  await page.getByTestId("tool-activity").waitFor({ timeout: 15_000 });
  process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
  await page.getByTestId("notice").getByText("退出", { exact: false }).waitFor({ timeout: 10_000 });
  report.hostExitVisible = true;
} finally {
  await exitApp.close();
}

const unpackedHost = join(appPath, "Contents", "Resources", "app.asar.unpacked", "out", "host");
const hostFile = ["index.mjs", "index.cjs", "index.js"]
  .map((name) => join(unpackedHost, name))
  .find((candidate) => existsSync(candidate));
if (hostFile === undefined) {
  throw new Error(`No host bundle under ${unpackedHost}`);
}
const hidden = `${hostFile}.hidden`;
renameSync(hostFile, hidden);
const broken = await electron.launch({ executablePath: executable, cwd: root });
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
