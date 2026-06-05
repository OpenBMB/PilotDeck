import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pilotdeckDesktop", {
  getRuntimeInfo: () => ipcRenderer.invoke("pilotdeck:get-runtime-info"),
});
