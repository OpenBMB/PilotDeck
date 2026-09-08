import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type RuntimeStatus = {
  phase: string;
  message: string;
  logPath?: string;
  error?: string;
};

contextBridge.exposeInMainWorld("pilotdeckDesktop", {
  checkUpdates: () => ipcRenderer.invoke("pilotdeck:update-check"),
  getUpdateStatus: () => ipcRenderer.invoke("pilotdeck:update-status"),
  startUpdate: () => ipcRenderer.invoke("pilotdeck:update-start"),
  cancelUpdate: () => ipcRenderer.invoke("pilotdeck:update-cancel"),
  getRuntimeInfo: () => ipcRenderer.invoke("pilotdeck:get-runtime-info"),
  onRuntimeStatus: (callback: (status: RuntimeStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: RuntimeStatus) => callback(status);
    ipcRenderer.on("pilotdeck:runtime-status", listener);
    return () => ipcRenderer.off("pilotdeck:runtime-status", listener);
  },
  retryRuntime: () => ipcRenderer.invoke("pilotdeck:retry-runtime"),
  openRuntimeLog: () => ipcRenderer.invoke("pilotdeck:open-runtime-log"),
  pickFolder: () => ipcRenderer.invoke("pilotdeck:pick-folder"),
});
