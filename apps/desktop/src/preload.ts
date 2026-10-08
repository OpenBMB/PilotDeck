import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { installWindowChrome } from "./preloadChrome";
import type { DesktopCommand, DesktopMenuState } from "./desktopCommands";
import type { DesktopAppearance } from './appearance';
import type { FilePickerRequest, FilePickerResult } from './filePicker';

installWindowChrome(process.platform, ipcRenderer);

type RuntimeStatus = {
  phase: string;
  message: string;
  logPath?: string;
  error?: string;
};

contextBridge.exposeInMainWorld("pilotdeckDesktop", {
  platform: process.platform,
  setMenuState: (state: DesktopMenuState) => ipcRenderer.invoke("pilotdeck:menu-state", state),
  onCommand: (callback: (command: DesktopCommand) => void) => {
    const listener = (_event: IpcRendererEvent, command: DesktopCommand) => callback(command);
    ipcRenderer.on("pilotdeck:command", listener);
    return () => ipcRenderer.off("pilotdeck:command", listener);
  },
  getAppearance: () => ipcRenderer.sendSync("pilotdeck:get-appearance") as DesktopAppearance | null,
  getAppearanceCapabilities: () => ipcRenderer.invoke('pilotdeck:appearance-capabilities') as Promise<{ hardwareAcceleration: boolean }>,
  setAppearance: (value: Partial<DesktopAppearance>) => ipcRenderer.invoke("pilotdeck:set-appearance", value),
  saveAppearanceImage: (bytes: Uint8Array) => ipcRenderer.invoke('pilotdeck:save-appearance-image', bytes),
  readAppearanceImage: (id: string) => ipcRenderer.invoke('pilotdeck:read-appearance-image', id),
  deleteAppearanceImage: (id: string) => ipcRenderer.invoke('pilotdeck:delete-appearance-image', id),
  checkUpdates: () => ipcRenderer.invoke("pilotdeck:update-check"),
  getUpdateStatus: () => ipcRenderer.invoke("pilotdeck:update-status"),
  startUpdate: () => ipcRenderer.invoke("pilotdeck:update-start"),
  cancelUpdate: () => ipcRenderer.invoke("pilotdeck:update-cancel"),
  pauseUpdate: () => ipcRenderer.invoke("pilotdeck:update-pause"),
  resumeUpdate: () => ipcRenderer.invoke("pilotdeck:update-resume"),
  getRuntimeInfo: () => ipcRenderer.invoke("pilotdeck:get-runtime-info"),
  getAboutInfo: () => ipcRenderer.invoke("pilotdeck:about-info"),
  onRuntimeStatus: (callback: (status: RuntimeStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: RuntimeStatus) => callback(status);
    ipcRenderer.on("pilotdeck:runtime-status", listener);
    return () => ipcRenderer.off("pilotdeck:runtime-status", listener);
  },
  retryRuntime: () => ipcRenderer.invoke("pilotdeck:retry-runtime"),
  openRuntimeLog: () => ipcRenderer.invoke("pilotdeck:open-runtime-log"),
  pickFolder: () => ipcRenderer.invoke("pilotdeck:pick-folder"),
  pickFiles: (request: FilePickerRequest) => ipcRenderer.invoke('pilotdeck:pick-files', request) as Promise<FilePickerResult>,
});
