import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateUiEntry } from "../scripts/e2e-ui-guard.mjs";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("visible Electron E2E entry guard", () => {
  it("allows explicit local opt-in and strips the switch from positional arguments", () => {
    expect(evaluateUiEntry({ platform: "darwin", env: { CI: "true", DISPLAY: ":0" }, argv: ["node", "script.mjs", "shot.png", "--allow-ui"] }))
      .toMatchObject({ allowed: true, source: "explicit opt-in", args: ["node", "script.mjs", "shot.png"] });
  });

  it("allows only the marked Linux CI Xvfb environment without local opt-in", () => {
    expect(evaluateUiEntry({ platform: "linux", env: { CI: "true", DISPLAY: ":99", CHIVGENT_E2E_XVFB: "1" }, argv: [] }).allowed).toBe(true);
    expect(evaluateUiEntry({ platform: "linux", env: { CI: "true", DISPLAY: ":99" }, argv: [] }).allowed).toBe(false);
    expect(evaluateUiEntry({ platform: "darwin", env: { CI: "true", DISPLAY: ":99", CHIVGENT_E2E_XVFB: "1" }, argv: [] }).allowed).toBe(false);
    expect(evaluateUiEntry({ platform: "linux", env: { DISPLAY: ":99", CHIVGENT_E2E_XVFB: "1" }, argv: [] }).allowed).toBe(false);
  });

  function safeFixture(name: string, removeGuard = false) {
    const root = mkdtempSync(join(tmpdir(), "chivgent-ui-guard-test-")); roots.push(root);
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const scriptDir = join(root, "apps/desktop/scripts");
    const packageDir = join(root, "apps/desktop/node_modules/playwright-core");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    for (const helper of ["e2e-ui-guard.mjs", "e2e-lifecycle.mjs"]) {
      copyFileSync(join(repo, "apps/desktop/scripts", helper), join(scriptDir, helper));
    }
    const original = readFileSync(join(repo, "apps/desktop/scripts", name), "utf8");
    const source = removeGuard ? original.replace("requireUiEntry();", "") : original;
    if (removeGuard) expect(source).not.toBe(original);
    const script = join(scriptDir, name);
    writeFileSync(script, source);
    const marker = join(root, "playwright-imported.marker");
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: "playwright-core", main: "index.cjs", exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
    }));
    writeFileSync(join(packageDir, "index.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CHIVGENT_FAKE_PLAYWRIGHT_MARKER, 'imported'); throw new Error('fake Playwright import blocked before Electron');");
    writeFileSync(join(packageDir, "index.cjs"), "require('node:fs').writeFileSync(process.env.CHIVGENT_FAKE_PLAYWRIGHT_MARKER, 'imported'); throw new Error('fake Playwright require blocked before Electron');");
    const args = name === "verify-packaged.mjs" ? [script, join(root, "does-not-exist.app")] : [script];
    const result = spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CI: "false", DISPLAY: ":0", CHIVGENT_E2E_XVFB: "", TMPDIR: tmp, CHIVGENT_HOME: join(root, "home"), CHIVGENT_FAKE_PLAYWRIGHT_MARKER: marker },
      timeout: 5_000,
    });
    return { marker, result, tmp };
  }

  it.each(["verify-readonly.mjs", "verify-history.mjs", "verify-packaged.mjs"])("rejects %s before Playwright import or fixture creation", (name) => {
    const { marker, result, tmp } = safeFixture(name);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("visible Electron window");
    expect(result.stderr).toContain("--allow-ui");
    expect(readdirSync(tmp)).toEqual([]);
    expect(() => readFileSync(marker)).toThrow();
  });

  it.each(["verify-readonly.mjs", "verify-history.mjs", "verify-packaged.mjs"])("fails the %s guard regression before any real Electron can load", (name) => {
    const { marker, result } = safeFixture(name, true);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain("fake Playwright");
    expect(readFileSync(marker, "utf8")).toBe("imported");
  });
});
