import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../protocol/channels.js";
import { isHostToMain, type HostStatus, type IpcResult } from "../protocol/messages.js";

export interface DesktopApi {
  initialize(): Promise<IpcResult<unknown>>;
  selectProject(): Promise<IpcResult<unknown>>;
  saveProviderProfile(payload: { requestId: string; provider: string; model: string; apiKey?: string; baseURL?: string }): Promise<IpcResult<unknown>>;
  start(payload: { requestId: string; prompt: string }): Promise<IpcResult<unknown>>;
  interrupt(payload: { requestId: string; runId: string }): Promise<IpcResult<unknown>>;
  onEvent(listener: (message: unknown) => void): () => void;
  onHostStatus(listener: (status: HostStatus) => void): () => void;
}

const api: DesktopApi = {
  initialize: () => ipcRenderer.invoke(IPC.initialize),
  selectProject: () => ipcRenderer.invoke(IPC.selectProject),
  saveProviderProfile: (payload) => ipcRenderer.invoke(IPC.saveProviderProfile, payload),
  start: (payload) => ipcRenderer.invoke(IPC.start, payload),
  interrupt: (payload) => ipcRenderer.invoke(IPC.interrupt, payload),
  onEvent: (listener) => subscribe(IPC.event, listener, isHostToMain),
  onHostStatus: (listener) => subscribe(IPC.hostStatus, listener, isHostStatus),
};

contextBridge.exposeInMainWorld("chivgent", api);

function subscribe<T>(
  channel: string,
  listener: (payload: T) => void,
  accept: (value: unknown) => value is T,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    if (accept(payload)) {
      listener(payload);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function isHostStatus(value: unknown): value is HostStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const phase = (value as { phase?: unknown }).phase;
  return phase === "starting" || phase === "ready" || phase === "failed" || phase === "exited";
}
