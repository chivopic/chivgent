export function evaluateUiEntry({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  const allowUi = argv.includes("--allow-ui");
  const ciXvfb = platform === "linux" && env.CI === "true" &&
    env.CHIVGENT_E2E_XVFB === "1" && Boolean(env.DISPLAY);
  return {
    allowed: allowUi || ciXvfb,
    source: allowUi ? "explicit opt-in" : ciXvfb ? "Linux CI Xvfb" : undefined,
    args: argv.filter(argument => argument !== "--allow-ui"),
  };
}

export function requireUiEntry(options) {
  const result = evaluateUiEntry(options);
  if (!result.allowed) {
    console.error("This verification launches a visible Electron window. Local runs require explicit --allow-ui; automatic runs are allowed only from the Linux CI Xvfb job.");
    process.exit(2);
  }
  process.argv.splice(0, process.argv.length, ...result.args);
}
