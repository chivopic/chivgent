import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * The host bundle is unpacked from the asar. utilityProcess loads it as a
 * normal Node entry, and that loader does not reliably execute a script that
 * still lives inside the archive.
 */
export function hostEntryPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked", "out", "host", "index.mjs");
  }
  return join(__dirname, "../host/index.mjs");
}

export function hostEntryError(): string | undefined {
  const entry = hostEntryPath();
  if (existsSync(entry)) {
    return undefined;
  }
  return `Agent host 启动失败：找不到 ${entry}。`;
}
