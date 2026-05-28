/**
 * Preload script — exposes minimal APIs to two different renderers:
 *
 *   1. `window.pilotdeck` — for the PilotDeck web UI renderer (loaded from
 *      http://127.0.0.1:<port>/). Tells it that it's running inside the
 *      desktop shell.
 *   2. `window.pilotdeckOnboarding` — for the first-run onboarding HTML.
 *      Lets it persist user-entered API credentials and quit the app.
 *
 * The same preload runs in both windows; only the relevant API surface is
 * actually used by each.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pilotdeck", {
  isDesktop: true,
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),
  getServerPort: (): Promise<number | null> =>
    ipcRenderer.invoke("get-server-port"),
  getServerStatus: (): Promise<{
    state: "running" | "stopped";
    port: number | null;
  }> => ipcRenderer.invoke("get-server-status"),
});

/**
 * Splash window IPC bridge. Only the splash renderer uses this; other
 * windows ignore it. The splash is purely a one-way display — main
 * pushes status updates, renderer just renders. We expose only an
 * `onStatus` subscription, never `send` back, so a compromised splash
 * can't trigger any privileged main-process action.
 */
contextBridge.exposeInMainWorld("pilotdeckSplash", {
  onStatus: (
    callback: (payload: { text?: string; footer?: string }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { text?: string; footer?: string },
    ): void => {
      try {
        callback(payload);
      } catch {
        /* swallow renderer-side errors so a bad listener can't kill the splash */
      }
    };
    ipcRenderer.on("splash:status", listener);
    return () => ipcRenderer.removeListener("splash:status", listener);
  },
});

contextBridge.exposeInMainWorld("pilotdeckOnboarding", {
  save: (payload: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke("onboarding:save", payload),
  testProvider: (payload: {
    providerType: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{
    endpoint: string;
    overall: "ok" | "warning" | "error" | "skipped";
    checks: Array<{
      id: string;
      label: string;
      level: "ok" | "warning" | "error" | "skipped";
      detail: string;
      hint?: string;
      durationMs?: number;
    }>;
  }> => ipcRenderer.invoke("onboarding:testProvider", payload),
  cancel: (): void => ipcRenderer.send("onboarding:cancel"),
});
