import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { IPC } from "../protocol/channels.js";
import {
  validateMainToHost,
  type HostStatus,
  type HostToMain,
  type IpcResult,
} from "../protocol/messages.js";
import { createHostBridge, type HostBridge } from "./host-bridge.js";

let mainWindow: BrowserWindow | undefined;
let quitting = false;
const bridge: HostBridge = createHostBridge();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: "chivgent",
    backgroundColor: "#faf9f5",
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.on("close", (event) => {
    if (quitting || process.platform !== "darwin") {
      return;
    }
    event.preventDefault();
    window.hide();
  });
  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
}

function sendToRenderer(channel: string, payload: unknown): void {
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) {
    return;
  }
  contents.send(channel, payload);
}

function assertSender(sender: Electron.WebContents): void {
  if (mainWindow === undefined || sender !== mainWindow.webContents) {
    throw new Error("Rejected renderer sender.");
  }
}

function installIpc(): void {
  ipcMain.handle(IPC.initialize, async (event) => {
    assertSender(event.sender);
    return callHost({ type: "initialize", requestId: `boot-${randomUUID()}` });
  });
  ipcMain.handle(IPC.selectProject, async (event) => {
    assertSender(event.sender);
    const choice = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || choice.filePaths[0] === undefined) return failure("cancelled", "未选择项目目录。");
    return callHost({ type: "select-project", requestId: `project-${randomUUID()}`, path: choice.filePaths[0] });
  });
  ipcMain.handle(IPC.saveProviderProfile, async (event, payload: unknown) => {
    assertSender(event.sender);
    const request = validateMainToHost({ ...(typeof payload === "object" && payload !== null ? payload : {}), type: "save-provider-profile" });
    if (typeof request === "string" || request.type !== "save-provider-profile") return failure("bad_request", typeof request === "string" ? request : "Invalid Provider profile.");
    return callHost(request);
  });
  ipcMain.handle(IPC.start, async (event, payload: unknown) => {
    assertSender(event.sender);
    const request = validateMainToHost({
      ...(typeof payload === "object" && payload !== null ? payload : {}),
      type: "start",
    });
    if (typeof request === "string" || request.type !== "start") {
      return failure("bad_request", typeof request === "string" ? request : "Invalid start.");
    }
    return callHost(request);
  });
  ipcMain.handle(IPC.interrupt, async (event, payload: unknown) => {
    assertSender(event.sender);
    const request = validateMainToHost({
      ...(typeof payload === "object" && payload !== null ? payload : {}),
      type: "interrupt",
    });
    if (typeof request === "string" || request.type !== "interrupt") {
      return failure(
        "bad_request",
        typeof request === "string" ? request : "Invalid interrupt.",
      );
    }
    return callHost(request);
  });
}

async function callHost(message: Parameters<HostBridge["request"]>[0]): Promise<IpcResult<HostToMain>> {
  try {
    const value = await bridge.request(message);
    if (value.type === "error") {
      return failure(value.code, value.message);
    }
    return { ok: true, value };
  } catch (error: unknown) {
    return failure(
      "host_unavailable",
      error instanceof Error ? error.message : "Agent host 没有回应。",
    );
  }
}

function failure(code: string, message: string): IpcResult<never> {
  return { ok: false, code, message };
}

function installMenu(): void {
  app.setName("chivgent");
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "chivgent",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "退出 chivgent" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
    ]),
  );
}

app.setAboutPanelOptions({
  applicationName: "chivgent",
  applicationVersion: app.getVersion(),
  copyright: "chivgent Desktop",
});

app.whenReady().then(() => {
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "resources", "icon.png"));
  }
  installMenu();
  installIpc();
  process.env["CHIVGENT_DESKTOP_HISTORY_DIR"] ??= join(app.getPath("userData"), "desktop-history-v1");
  process.env["CHIVGENT_DESKTOP_CONFIG_DIR"] ??= join(app.getPath("userData"), "desktop-config-v1");
  bridge.onEvent((message) => {
    sendToRenderer(IPC.event, message);
  });
  bridge.onStatus((status: HostStatus) => {
    sendToRenderer(IPC.hostStatus, status);
  });
  mainWindow = createWindow();
  bridge.start();
  app.on("activate", () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      mainWindow = createWindow();
      return;
    }
    mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }
  event.preventDefault();
  quitting = true;
  void bridge.shutdown().catch((error: unknown) => {
    console.error("Agent host shutdown failed; continuing application exit after reporting the cleanup error.", error);
  }).finally(() => {
    app.quit();
  });
});

