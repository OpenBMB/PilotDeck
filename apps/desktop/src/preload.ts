import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type RuntimeStatus = {
  phase: string;
  message: string;
  logPath?: string;
  error?: string;
};

contextBridge.exposeInMainWorld("pilotdeckDesktop", {
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
